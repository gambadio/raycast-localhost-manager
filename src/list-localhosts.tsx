/// <reference path="../raycast-env.d.ts" />
/// <reference path="./types.d.ts" />

import { Action, ActionPanel, Icon, List, showToast, Toast, Detail, getPreferenceValues } from "@raycast/api";
import { execa } from "execa";
import pidusage from "pidusage";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

// =====================
// System binary paths for macOS
// =====================
const LSOF_PATH = "/usr/sbin/lsof";
const PS_PATH = "/bin/ps";
const KILL_PATH = "/bin/kill";
const CURRENT_USER = process.env.USER || "";
// Docker might be in different locations depending on installation
const DOCKER_PATHS = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker"];

// =====================
// Types
// =====================
export type Listener = {
  pid: number;
  cmd: string;
  user?: string;
  uid?: number;
  address: string; // e.g., 127.0.0.1 or *
  port: number;
  protocol: "tcp" | "udp";
  execPath?: string;
  cwd?: string;
  cmdline?: string;
  cpu?: number; // %
  memory?: number; // bytes
  startedAt?: string;
  // Derived, for nicer display
  displayName?: string;
};

export type DockerPort = {
  hostIp?: string; // 0.0.0.0, 127.0.0.1, ::, etc.
  hostPort?: number; // host port if published
  containerPort: number;
  protocol: string; // tcp/udp
};

export type DockerContainer = {
  id: string;
  name: string;
  image: string;
  status: string; // e.g., "Up 2 minutes"
  ports: DockerPort[];
  cpu?: number; // percent
  mem?: string; // raw string from docker stats (e.g., "123MiB / 2GiB")
};

type LsofRecord = {
  pid?: number;
  cmd?: string;
  uid?: number;
  user?: string;
  names: string[]; // each 'n' line (address:port and state)
  proto: "tcp" | "udp";
};

// =====================
// Host listeners (lsof)
// =====================
async function getListeningByProto(proto: "tcp" | "udp"): Promise<LsofRecord[]> {
  const args = proto === "tcp" ? ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcPnTuL"] : ["-nP", "-iUDP", "-FpcPnTuL"];
  const { stdout } = await execa(LSOF_PATH, args, { timeout: 4000 });
  const lines = stdout.split("\n");
  const records: LsofRecord[] = [];
  let current: LsofRecord | null = null;

  for (const line of lines) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      if (current && (current.pid || current.cmd)) records.push(current);
      current = { names: [], proto } as LsofRecord;
      const pid = Number(val);
      if (!Number.isNaN(pid)) current.pid = pid;
    } else if (!current) {
      continue;
    } else {
      switch (tag) {
        case "c":
          current.cmd = val;
          break;
        case "u": {
          const uid = Number(val);
          if (!Number.isNaN(uid)) current.uid = uid;
          break;
        }
        case "L":
          current.user = val;
          break;
        case "n":
          current.names.push(val);
          break;
      }
    }
  }
  if (current && (current.pid || current.cmd)) records.push(current);
  return records;
}

function parseAddressPort(nameLine: string): { address: string; port: number } | null {
  // name lines may be like "127.0.0.1:3000 (LISTEN)", "*:8080 (LISTEN)", "::1:53", "*:5353"
  const raw = nameLine.split(" ")[0]; // drop trailing state for TCP
  const lastColon = raw.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const address = raw.slice(0, lastColon);
  const portStr = raw.slice(lastColon + 1);
  const port = Number(portStr);
  if (Number.isNaN(port)) return null;
  return { address, port };
}

async function getCwd(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execa(LSOF_PATH, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 2500 });
    const nLine = stdout.split("\n").find((l) => l.startsWith("n"));
    return nLine ? nLine.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

async function getPsInfo(
  pid: number
): Promise<{ execPath?: string; cmdline?: string; startedAt?: string; fullCommand?: string }> {
  try {
    const { stdout } = await execa(PS_PATH, ["-o", "command=,lstart=", "-p", String(pid)], { timeout: 2500 });
    const line = stdout.trim();
    if (!line) return {};

    // Try to extract lstart from the end of the line
    const match = line.match(/(.*?\S)\s{2,}([A-Z][a-z]{2}\s[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/);
    let execPlusArgs = line;
    let lstart = undefined as string | undefined;
    if (match) {
      execPlusArgs = match[1];
      lstart = match[2];
    }

    // Split the full command to get executable path and arguments
    const parts = execPlusArgs.split(/\s+/);
    const execPath = parts[0];
    const cmdline = parts.slice(1).join(" ");

    // Get the full command name from the executable path
    const fullCommand = basename(execPath) || execPath;

    return { execPath, cmdline, startedAt: lstart, fullCommand };
  } catch {
    return {};
  }
}

async function enrichWithStats(pids: number[]): Promise<Record<number, { cpu?: number; memory?: number }>> {
  const out: Record<number, { cpu?: number; memory?: number }> = {};
  for (const pid of pids) {
    try {
      const s = await pidusage(pid);
      out[pid] = { cpu: s.cpu, memory: s.memory };
    } catch {
      out[pid] = {};
    }
  }
  return out;
}

function formatMem(bytes?: number): string {
  if (!bytes || bytes <= 0) return "-";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function basename(p?: string) {
  if (!p) return undefined;
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1];
}

function friendlyAddress(address: string) {
  if (address === "127.0.0.1" || address === "::1") return "localhost";
  if (address === "*" || address === "0.0.0.0" || address === "::") return "all network interfaces";
  return address;
}

// Kill owners by port (supports tcp/udp)
async function killOwnersByPort(port: number, proto: "tcp" | "udp", sig: "TERM" | "KILL") {
  const selector = proto === "tcp" ? `-tiTCP:${port}` : `-tiUDP:${port}`;
  const args = [selector];
  if (proto === "tcp") args.push("-sTCP:LISTEN");
  const { stdout } = await execa(LSOF_PATH, args, { timeout: 2000 });
  const pids = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => Number(l))
    .filter((n) => !Number.isNaN(n));
  for (const pid of pids) {
    await execa(KILL_PATH, ["-" + sig, String(pid)]);
  }
  return pids.length;
}

// =====================
// Docker helpers (docker ps / stats)
// =====================
async function findDockerPath(): Promise<string | null> {
  for (const path of DOCKER_PATHS) {
    try {
      await execa(path, ["version", "--format", "{{.Server.Version}}"], { timeout: 1000 });
      return path;
    } catch {
      // Continue to next path
    }
  }
  return null;
}

async function hasDocker(): Promise<boolean> {
  const dockerPath = await findDockerPath();
  return dockerPath !== null;
}

function parseDockerPorts(portsField: string): DockerPort[] {
  if (!portsField) return [];
  return portsField
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.includes("->")) {
        const [host, cont] = entry.split("->");
        let hostIp: string | undefined;
        let hostPort: number | undefined;
        const lastColon = host.lastIndexOf(":");
        if (lastColon !== -1) {
          hostIp = host.slice(0, lastColon).replace(/^\*$/, "0.0.0.0");
          const hp = Number(host.slice(lastColon + 1));
          if (!Number.isNaN(hp)) hostPort = hp;
        }
        const [cpStr, proto = "tcp"] = cont.split("/");
        const containerPort = Number(cpStr);
        return { hostIp, hostPort, containerPort, protocol: proto.toLowerCase() } as DockerPort;
      }
      const [cpStr, proto = "tcp"] = entry.split("/");
      const containerPort = Number(cpStr);
      return { containerPort, protocol: proto.toLowerCase() } as DockerPort;
    })
    .filter((p) => !Number.isNaN(p.containerPort));
}

async function getDockerContainers(): Promise<DockerContainer[]> {
  const dockerPath = await findDockerPath();
  if (!dockerPath) return [];

  const { stdout } = await execa(
    dockerPath,
    ["ps", "--no-trunc", "--format", "{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Ports}}\t{{.Status}}"],
    { timeout: 3000 }
  );
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const [id, image, name, portsField, status] = line.split("\t");
    return {
      id,
      image,
      name,
      status,
      ports: parseDockerPorts(portsField || ""),
    } as DockerContainer;
  });
}

async function getDockerStatsByName(): Promise<Record<string, { cpu?: number; mem?: string }>> {
  const stats: Record<string, { cpu?: number; mem?: string }> = {};
  const dockerPath = await findDockerPath();
  if (!dockerPath) return stats;

  try {
    const { stdout } = await execa(
      dockerPath,
      ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
      { timeout: 3500 }
    );
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, cpuPerc, memUsage] = line.split("\t");
      const cpu = cpuPerc?.endsWith("%") ? Number(cpuPerc.replace("%", "")) : undefined;
      stats[name] = { cpu, mem: memUsage };
    }
  } catch {
    // docker stats may fail if Docker is starting; ignore
  }
  return stats;
}

// =====================
// UI Command
// =====================
export default function Command() {
  const preferences = getPreferenceValues<Preferences.ListLocalhosts>();
  const [listeners, setListeners] = useState<Listener[]>([]);
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // View
  const [viewMode, setViewMode] = useState<"simple" | "advanced">(preferences.defaultViewMode || "simple");
  type OptionsMode = "all" | "hideSystem" | "hideZeroCPU" | "hideBoth";
  const [optionsMode, setOptionsMode] = useState<OptionsMode>("all");

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Host listeners (TCP + UDP)
      const [tcp, udp] = await Promise.all([getListeningByProto("tcp"), getListeningByProto("udp")]);
      const records = [...tcp, ...udp];

      const base: Listener[] = [];
      for (const r of records) {
        for (const n of r.names) {
          // Ignore connected UDP entries like "127.0.0.1:12345->8.8.8.8:53"
          if (n.includes("->")) continue;
          const ap = parseAddressPort(n);
          if (!ap || !r.pid || !r.cmd) continue;
          base.push({
            pid: r.pid,
            cmd: r.cmd,
            user: r.user,
            uid: r.uid,
            address: ap.address,
            port: ap.port,
            protocol: r.proto,
