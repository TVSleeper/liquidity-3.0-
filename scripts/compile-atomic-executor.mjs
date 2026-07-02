import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const contractPath = path.join(root, "contracts", "AtomicLiquidityExecutor.sol");
const source = fs.readFileSync(contractPath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "AtomicLiquidityExecutor.sol": { content: source }
  },
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"]
      }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((item) => item.severity === "error");
if (errors.length) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

const artifact = output.contracts["AtomicLiquidityExecutor.sol"].AtomicLiquidityExecutor;
const generatedDir = path.join(root, "src", "generated");
fs.mkdirSync(generatedDir, { recursive: true });
fs.writeFileSync(
  path.join(generatedDir, "AtomicLiquidityExecutor.ts"),
  `import type { Abi, Hex } from "viem";\n\nexport const atomicExecutorCompiledAbi = ${JSON.stringify(
    artifact.abi,
    null,
    2
  )} as const satisfies Abi;\n\nexport const atomicExecutorBytecode = "0x${
    artifact.evm.bytecode.object
  }" as Hex;\n`
);

console.log("AtomicLiquidityExecutor compiled");
