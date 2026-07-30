import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentSystemBlueprint } from "./agent-blueprint.js";

export interface BlueprintWriteTransaction {
  rollback(): void;
  finalize(): void;
}

interface ResourceWrite {
  destination: string;
  content: string;
  temporary: string;
  backup?: string;
  committed: boolean;
}

function ensureDirectory(path: string, created: string[]): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Cannot create generated resources: ${path} is not a real directory`);
    }
    return;
  }

  const parent = dirname(path);
  if (parent !== path) ensureDirectory(parent, created);
  mkdirSync(path);
  created.push(path);
}

function assertDestination(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Cannot overwrite generated resource: ${path} is not a regular file`);
  }
}

function removeIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

/**
 * Stage every generated file before replacing anything. Existing files are
 * renamed to backups during commit and retained until finalize(), allowing the
 * caller to roll the whole system back when registry reload/validation fails.
 */
export function writeBlueprintFilesAtomically(
  targetAgentDir: string,
  blueprint: AgentSystemBlueprint,
): BlueprintWriteTransaction {
  const nonce = `${process.pid}-${randomUUID()}`;
  const resources = [
    ...blueprint.agents.map((agent) => ({
      destination: join(targetAgentDir, `${agent.name}.md`),
      content: agent.content,
    })),
    ...blueprint.skills.map((skill) => ({
      destination: join(targetAgentDir, "..", "skills", skill.name, "SKILL.md"),
      content: skill.content,
    })),
  ];
  const createdDirectories: string[] = [];
  const writes: ResourceWrite[] = resources.map((resource) => ({
    ...resource,
    temporary: join(
      dirname(resource.destination),
      `.${basename(resource.destination)}.${nonce}.stage`,
    ),
    committed: false,
  }));

  const rollback = (): void => {
    for (const write of [...writes].reverse()) {
      try {
        if (write.committed) removeIfExists(write.destination);
        if (write.backup && existsSync(write.backup)) renameSync(write.backup, write.destination);
        removeIfExists(write.temporary);
      } catch {
        // Best effort: preserve the original thrown error. Any remaining backup
        // is deliberately left beside the destination for manual recovery.
      }
    }
    for (const directory of [...createdDirectories].reverse()) {
      try {
        rmdirSync(directory);
      } catch {
        // Directory is not empty or was concurrently claimed; leave it intact.
      }
    }
  };

  try {
    for (const write of writes) {
      ensureDirectory(dirname(write.destination), createdDirectories);
      assertDestination(write.destination);
    }

    for (const write of writes) {
      writeFileSync(write.temporary, write.content, { encoding: "utf-8", flag: "wx" });
    }

    for (const write of writes) {
      if (existsSync(write.destination)) {
        write.backup = join(
          dirname(write.destination),
          `.${basename(write.destination)}.${nonce}.backup`,
        );
        renameSync(write.destination, write.backup);
      }
      try {
        renameSync(write.temporary, write.destination);
        write.committed = true;
      } catch (error) {
        if (write.backup && existsSync(write.backup)) renameSync(write.backup, write.destination);
        throw error;
      }
    }
  } catch (error) {
    rollback();
    throw error;
  }

  let closed = false;
  return {
    rollback(): void {
      if (closed) return;
      closed = true;
      rollback();
    },
    finalize(): void {
      if (closed) return;
      closed = true;
      for (const write of writes) {
        if (write.backup) {
          try {
            removeIfExists(write.backup);
          } catch {
            // The committed destination is valid; a stale backup is safer than
            // rolling back a successful registry load.
          }
        }
      }
    },
  };
}
