import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const contractsDir = path.join(root, "contracts");

const sources = {};
for (const file of fs.readdirSync(contractsDir)) {
  if (!file.endsWith(".sol")) continue;
  const sourceName = `contracts/${file}`;
  sources[sourceName] = {
    content: fs.readFileSync(path.join(contractsDir, file), "utf8")
  };
}

const input = {
  language: "Solidity",
  sources,
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

const generatedDir = path.join(root, "src", "generated");
const botGeneratedDir = path.join(root, "bot", "generated");
fs.mkdirSync(generatedDir, { recursive: true });
fs.mkdirSync(botGeneratedDir, { recursive: true });

const artifacts = [
  {
    source: "contracts/AtomicLiquidityExecutor.sol",
    contract: "AtomicLiquidityExecutor",
    tsPath: path.join(generatedDir, "AtomicLiquidityExecutor.ts"),
    abiName: "atomicExecutorCompiledAbi",
    bytecodeName: "atomicExecutorBytecode",
    jsonPath: path.join(botGeneratedDir, "AtomicLiquidityExecutor.json")
  },
  {
    source: "contracts/AutonomousRangeStrategy.sol",
    contract: "AutonomousRangeStrategy",
    tsPath: path.join(generatedDir, "AutonomousRangeStrategy.ts"),
    abiName: "autonomousRangeStrategyCompiledAbi",
    bytecodeName: "autonomousRangeStrategyBytecode",
    jsonPath: path.join(botGeneratedDir, "AutonomousRangeStrategy.json")
  }
];

for (const item of artifacts) {
  const artifact = output.contracts[item.source]?.[item.contract];
  if (!artifact) {
    console.error(`Artifact not found: ${item.source}:${item.contract}`);
    process.exit(1);
  }
  const bytecode = `0x${artifact.evm.bytecode.object}`;
  fs.writeFileSync(
    item.tsPath,
    `import type { Abi, Hex } from "viem";\n\nexport const ${item.abiName} = ${JSON.stringify(
      artifact.abi,
      null,
      2
    )} as const satisfies Abi;\n\nexport const ${item.bytecodeName} = "${bytecode}" as Hex;\n`
  );
  fs.writeFileSync(
    item.jsonPath,
    `${JSON.stringify({ abi: artifact.abi, bytecode }, null, 2)}\n`
  );
  console.log(`${item.contract} compiled`);
}
