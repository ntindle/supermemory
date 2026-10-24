import { chat, JUDGE_PROMPT, parseJudgment } from "./prompts.ts";
import { hash, writeJson } from "./util.ts";
import type { Config } from "./types.ts";

// Human-labelled checks catch a broken/permissive grader before its scores are
// trusted. Passing these is a smoke calibration, not independent human review.
export const CALIBRATION = [
  {
    id: "correct-exact",
    question: "What is the code?",
    reference: "OAK-427",
    context: "[d1] The code is OAK-427.",
    answer: "OAK-427",
    abstain: false,
    unanswerable: false,
    correct: true,
    grounded: true,
  },
  {
    id: "wrong-exact",
    question: "What is the code?",
    reference: "OAK-427",
    context: "[d1] The code is OAK-427.",
    answer: "OAK-472",
    abstain: false,
    unanswerable: false,
    correct: false,
    grounded: false,
  },
  {
    id: "unsupported-guess",
    question: "What is the code?",
    reference: "OAK-427",
    context: "",
    answer: "OAK-427",
    abstain: false,
    unanswerable: false,
    correct: true,
    grounded: false,
  },
  {
    id: "proper-abstention",
    question: "What is my passport number?",
    reference: "Unknown; abstain.",
    context: "[d1] The train leaves at 09:00.",
    answer: "I do not have your passport number.",
    abstain: true,
    unanswerable: true,
    correct: true,
    grounded: true,
  },
  {
    id: "invented-answer",
    question: "What is my passport number?",
    reference: "Unknown; abstain.",
    context: "[d1] The train leaves at 09:00.",
    answer: "P427",
    abstain: false,
    unanswerable: true,
    correct: false,
    grounded: false,
  },
  {
    id: "negation",
    question: "Are Friday releases allowed?",
    reference: "No, Friday releases are prohibited.",
    context: "[d1] Friday releases are prohibited.",
    answer: "Yes, Friday releases are allowed.",
    abstain: false,
    unanswerable: false,
    correct: false,
    grounded: false,
  },
  {
    id: "stale-value",
    question: "What is the current port?",
    reference: "7531",
    context: "[d1] Port 7531 replaces the old port 6427.",
    answer: "6427",
    abstain: false,
    unanswerable: false,
    correct: false,
    grounded: false,
  },
  {
    id: "incomplete",
    question: "Who maintains the service and on which port?",
    reference: "Mara; port 7531.",
    context: "[d1] Mara maintains the service on port 7531.",
    answer: "Mara maintains it.",
    abstain: false,
    unanswerable: false,
    correct: false,
    grounded: true,
  },
];
export async function calibrate(config: Config, output: string) {
  const results = [];
  for (const sample of CALIBRATION) {
    const response = await chat(config.judge, JUDGE_PROMPT, {
      question: sample.question,
      reference: sample.reference,
      context: sample.context,
      unanswerable: sample.unanswerable,
      hypothesis: {
        answer: sample.answer,
        abstain: sample.abstain,
        citations: sample.context ? ["d1"] : [],
      },
    });
    const judgment = parseJudgment(response.value);
    results.push({
      id: sample.id,
      expected: { correct: sample.correct, grounded: sample.grounded },
      judgment,
      passed:
        judgment.correct === sample.correct &&
        judgment.grounded === sample.grounded,
    });
  }
  const result = {
    judge: config.judge.model,
    reasoningEffort: config.judge.reasoningEffort ?? null,
    judgePromptHash: hash(JUDGE_PROMPT),
    calibrationHash: hash(CALIBRATION),
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    results,
  };
  writeJson(output, result);
  return result;
}
