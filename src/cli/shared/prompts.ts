import { createInterface } from "node:readline";

/**
 * Prompt the user for interactive input via readline.
 */
export async function askQuestion(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await new Promise<string>((res) => rl.question(question, res));
  } finally {
    rl.close();
  }
}

/**
 * Ask a yes/no confirmation prompt. Returns true if the answer is 'y' or 'Y'.
 */
export async function askConfirmation(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  const answer = await askQuestion(question, input, output);
  return answer.trim().toLowerCase() === "y";
}
