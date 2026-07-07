import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const contractPath = path.join(root, "contracts", "PancakeV3ExitSeller.sol");

const input = {
  language: "Solidity",
  sources: {
    "contracts/PancakeV3ExitSeller.sol": {
      content: fs.readFileSync(contractPath, "utf8")
    }
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

const artifact = output.contracts["contracts/PancakeV3ExitSeller.sol"]?.PancakeV3ExitSeller;
if (!artifact) {
  console.error("PancakeV3ExitSeller artifact not found");
  process.exit(1);
}

const generatedDir = path.join(root, "src", "generated");
fs.mkdirSync(generatedDir, { recursive: true });

const bytecode = `0x${artifact.evm.bytecode.object}`;
fs.writeFileSync(
  path.join(generatedDir, "PancakeV3ExitSeller.ts"),
  `import type { Abi, Hex } from "viem";\n\nexport const pancakeV3ExitSellerCompiledAbi = ${JSON.stringify(
    artifact.abi,
    null,
    2
  )} as const satisfies Abi;\n\nexport const pancakeV3ExitSellerBytecode = "${bytecode}" as Hex;\n`
);

console.log("PancakeV3ExitSeller compiled");
