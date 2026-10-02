/**
 * Run the signaling server and the Next.js dev server together with one command.
 *
 * `concurrently` would be the obvious choice, but adding a dependency for this is
 * not worth it: two child processes and a Ctrl-C handler are ~60 lines of Node.
 *
 * Output from both processes is prefixed so a single log stays readable.
 */

import { spawn } from "node:child_process";
import process from "node:process";

const TASKS = [
  { label: "signal", color: "[36m", command: "npm", args: ["run", "signal"] },
  { label: "next  ", color: "[35m", command: "npm", args: ["run", "dev"] },
];

const RESET = "[0m";
const children = [];
let shuttingDown = false;

for (const task of TASKS) {
  const child = spawn(task.command, task.args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: process.env,
  });

  const prefix = `${task.color}${task.label}${RESET} │ `;

  const pipe = (stream, target) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
    stream.on("end", () => {
      if (buffer.length > 0) target.write(`${prefix}${buffer}\n`);
    });
  };

  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    process.stderr.write(`${prefix}exited with ${reason}; stopping everything.\n`);
    shutdown(typeof code === "number" && code !== 0 ? code : 1);
  });

  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  // Give the children a moment to close their listeners before we go.
  setTimeout(() => process.exit(code), 300).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

process.on("exit", () => {
  if (!shuttingDown) {
    for (const child of children) child.kill();
  }
});