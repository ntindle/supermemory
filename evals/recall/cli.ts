import path from "node:path";
import { startStack, stopStack } from "./local-stack.ts";
import { prepare } from "./prepare.ts";
import { MODES, run } from "./runner.ts";
import { compare } from "./compare.ts";
import { calibrate } from "./calibrate.ts";
import { readJson, writeJson } from "./util.ts";
import type { Config, Mode, Report, Suite } from "./types.ts";

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "stack-start" && args.length === 2)
    await startStack(args[1], readJson(args[0]));
  else if (command === "stack-stop" && args.length === 1) stopStack(args[0]);
  else if (command === "calibrate" && args.length === 2) {
    const result = await calibrate(readJson<Config>(args[0]), args[1]);
    console.log(
      JSON.stringify({
        phase: "judge-calibration",
        passed: result.passed,
        total: result.total,
      }),
    );
    if (result.passed !== result.total) process.exitCode = 1;
  } else if (command === "prepare" && args.length === 2) {
    const config = readJson<Config>(args[0]);
    await prepare(
      config,
      readJson<Suite>(
        config.suite ?? path.join(import.meta.dir, "suites/factory-v2.json"),
      ),
      args[1],
    );
  } else if (command === "run" && (args.length === 3 || args.length === 4)) {
    const report = await run(
      readJson<Config>(args[0]),
      args[1],
      args[2],
      args[3] ? (args[3].split(",") as Mode[]) : MODES,
    );
    if (report.rows.some((r) => r.status !== "ok")) process.exitCode = 1;
  } else if (
    command === "compare" &&
    (args.length === 5 ||
      (args.length === 6 && args[5] === "--allow-different-corpus"))
  ) {
    writeJson(
      args[4],
      compare(
        readJson<Report>(args[0]),
        readJson<Report>(args[1]),
        args[2] as Mode,
        args[3] as Mode,
        args[5] === "--allow-different-corpus",
      ),
    );
  } else
    throw new Error(
      "Usage: bun cli.ts stack-start INPUTS_JSON NEW_DIR | stack-stop DIR | calibrate CONFIG OUTPUT | prepare CONFIG CORPUS_DIR | run CONFIG CORPUS_DIR RESULTS_DIR [profile,memories,hybrid,closed-book,oracle] | compare BASE_REPORT CANDIDATE_REPORT BASE_MODE CANDIDATE_MODE OUTPUT [--allow-different-corpus]",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Evaluation failed");
  process.exitCode = 1;
}
