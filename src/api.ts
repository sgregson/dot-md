import * as dotenv from "dotenv";
import { promises as fsPromises } from "fs";
import os from "os";
import fs from "fs-extra";
import { execa } from "execa";
import tempWrite from "temp-write";

import path from "path";
import { fileURLToPath } from "url";
import parseSentence from "minimist-string";
import glob from "glob";

import colors from "colors/safe.js";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkFindReplace from "./remarkFindReplace.js";
import { confirm } from "@inquirer/prompts";
import { SelectOption } from "inquirer-select-pro";

const env = dotenv.parse(
  await fsPromises
    .readFile(path.resolve(process.cwd(), ".env"))
    // if file's missing, return nothing
    .catch(() => "")
);

export interface State {
  // file filter, glob-compatible
  filter: string;
  // selected files
  files: string[];
  // selected blocks
  blocks: Block[];
  totalBlocks?: { active: number; disabled: number; total: number };
}
export interface Block {
  // the markdown language signifier
  lang: string;
  // the content of the code block
  content: string;
  // the literal text of the meta block
  meta: string;
  // original file source
  source: string;
  // parsed options of the meta block
  options?: Partial<{
    action: "build" | "symlink" | "run";
    targetPath: string;
    title: string;
    when: string;
    disabled: boolean;
  }>;
  // if the block is disabled via options flags
  disabled: string | false;
  // derived label from title, meta or content
  label: string;
}

const interpreterMap = {
  sh: "sh",
  bash: "bash",
  zsh: "zsh",
  js: "node",
};

export const toMdAST = await unified()
  .use(remarkParse)
  .use(remarkFrontmatter)
  .use(remarkGfm)
  .use(remarkFindReplace, {
    replacements: { ...env, PLACEHOLDER: "derpy-do" },
    prefix: "%",
  });

/******************
 * Menu Stuff
 */
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const clearScreen = () => {
  console.log("\u001b[2J\u001b[0;0H");
};

/** const validator = menuValidator("validation message")*/

type Validator = <ValueType>(
  msg?: string
  // firstCheck?: never
) => (values: ReadonlyArray<SelectOption<ValueType>>) => string | boolean;

export const menuValidator: Validator =
  (msg = "empty selection, select a value", firstCheck = true) =>
  (values) => {
    if (!values.length && firstCheck) {
      firstCheck = false;
      return `${msg} or press 'enter' to continue.`;
    }

    return true;
  };

/*************
 * File stuff
 */
export async function globAsync(pattern: string, options = {}) {
  return new Promise<string[]>((resolve, reject) => {
    glob(pattern, options, (err, matches) => {
      if (err) reject(err);
      resolve(matches);
    });
  });
}

export const existsSync = (thePath): string | false => {
  if (fs.existsSync(thePath)) return thePath;
  if (fs.existsSync(process.cwd() + thePath)) return process.cwd() + thePath;

  return false;
};

export const cache = {
  path: ".dotfiles-md-cache",
  get() {
    return JSON.parse(fs.readFileSync(this.path, { encoding: "utf-8" }));
  },
  set(state: object) {
    fs.writeFileSync(this.path, JSON.stringify(state), { encoding: "utf-8" });
  },
  remove() {
    fs.unlinkSync(this.path);
  },
};

export const getDemoPath = () => {
  const demoDirname = fileURLToPath(new URL("../demo/", import.meta.url));
  return { dirname: demoDirname, filter: path.join(demoDirname, "**/*.md") };
};

/***************
 * Blocks
 */
const homeDirectory = os.homedir();

interface RunnableOptions {
  // whether to return disabled elements (or omit them)
  includeDisabled: boolean;
}

export async function getRunnableBlocks(
  inputFiles: string[],
  options: RunnableOptions
) {
  let blocks: Block[] = [];

  for (const filePath of inputFiles) {
    const fileContent = await fs.readFile(filePath);
    const theDoc = await toMdAST.parse(fileContent);

    blocks = blocks.concat(
      theDoc.children
        .filter(({ type }) => type === "code")
        .map(({ lang, meta, value }) => {
          const options: Block["options"] = Object.fromEntries(
            // minimist parses unknown args into an unknown "_" key
            // and all args we have are technically unknown
            parseSentence(meta ?? "")["_"].map((opt) => {
              if (!opt.includes("=")) {
                // the only option missing a "=" is the filePath
                return [
                  "targetPath",
                  opt.replace(/^(~|\$HOME)(?=$|\/|\\)/, homeDirectory),
                ];
              }

              return opt.split("=");
            })
          );

          let label = "";
          // prettier-ignore
          switch (options?.action) {
            case "run":
              label = `${options?.title ?? meta} (${colors.red(options?.action??"")}:${colors.underline(lang)})`;
              break;
            case "build":
            case "symlink":
            default:
              label = `${options?.title ?? meta} (${colors.green(options?.action??"")}:${colors.underline(lang)}) to ${options?.targetPath}`;
          }

          const theBlock: Block = {
            lang,
            meta,
            options,
            content: value,
            source: filePath,
            disabled: isDisabled(options),
            label,
          };

          return theBlock;
        })
        .filter(
          (block) =>
            // has an action
            !!block.options?.action &&
            // disabled while including disabled
            (!block.disabled || options.includeDisabled)
        )
    );
  }
  return blocks;
}

export const executeBlock = (now: string) => async (block: Block, i) => {
  const { options, source, content, lang } = block;
  const buildDir = path.join(process.cwd(), "build", now);
  let targetFile;

  // NOTE: exit early if there's no action to be done
  if (!options?.action) {
    console.log(`↪ SKIPPED (no action) ${colors.reset(block.label)}`);
    return;
  }

  if (options.action === "build" || options.action === "symlink") {
    // BAIL if there's no target path to build/link to
    if (!options.targetPath) {
      console.log(`↪ SKIPPED (no targetPath) ${colors.reset(block.label)}`);
      return;
    }

    targetFile = path.resolve(path.dirname(source), options.targetPath);
  }

  switch (options?.action) {
    case "build":
      // make sure the folder is available before writing
      await fs.ensureFile(targetFile);
      await fs.writeFile(targetFile, content).then(() => {
        console.log(`🔨 built ${path.relative(process.cwd(), targetFile)}`);
      });
      break;
    case "symlink":
      const buildFile = path.join(
        buildDir,
        "links",
        // named for the originating file, with $i to dedupe multiple symlinks
        `${i}-${path.parse(targetFile).base}`
      );
      await fs.ensureDir(path.dirname(buildFile));
      await fs.ensureDir(path.dirname(targetFile));

      // 1. build the source file and symlink it
      await fs.writeFile(buildFile, content).catch(
        // () =>
        //   console.log(`🔨 built ${path.relative(process.cwd(), buildFile)}`),
        async (_error) => {
          console.log("BUILD FAIL");
          // backup & move old version
          await fs.move(buildFile, buildFile + `.bak-${now}`);
          await fs.writeFile(buildFile, content);
        }
      );

      // 2. create a symlink at the targetfile location back to the source file
      // prettier-ignore
      const successMsg = `🔗 linked ${targetFile} to ${path.relative(process.cwd(), buildFile)}`
      // prettier-ignore
      const backupMsg = `💾 backup created at ${targetFile + `.bak-${now}`}`;
      await fs.ensureSymlink(buildFile, targetFile).then(
        () => console.log(successMsg),
        async (_error) => {
          // backup & move old version
          const oldFile = await fs.readlink(targetFile, {
            encoding: "utf8",
          });
          const oldContent = await fs
            .readFile(oldFile, {
              encoding: "utf8",
            })
            .catch((_err) => console.log("failed to read old content"));

          // if the content differs, flatten the symlink and back it up before removing
          if (
            oldContent &&
            (await fs.readFile(buildFile, {
              encoding: "utf8",
            })) !== oldContent
          ) {
            await fs
              .writeFile(targetFile + `.bak-${now}`, oldContent, {
                encoding: "utf8",
              })
              .then(() => console.log(backupMsg))
              .catch((err) =>
                console.log(
                  `🚧 failed to write ${targetFile} backup (${err.code}). Refer to old content at ${oldFile}`
                )
              );
          }

          await fs
            .remove(targetFile)
            .catch(() => `failed to remove old file ${targetFile}`);

          await fs
            .ensureSymlink(buildFile, targetFile)
            .then(() => console.log(successMsg))
            .catch((err) => {
              console.log(`🚧 failed to create symlink at ${targetFile}`);
              console.log(err);
            });
        }
      );
      break;
    case "run":
      if (!Object.keys(interpreterMap).includes(lang)) {
        console.log(
          `😬 hang in there, I still have to learn how to ${options?.action} a '${lang}' block.`
        );
        break;
      }

      // ALWAYS CHECK before executing scripts
      console.log(
        colors.red(`\n> ${colors.underline(lang)}\n> `) +
          block.content.split("\n").join("\n" + colors.red("> "))
      );
      const confirmRun = await confirm({ message: "run the above script?" });
      if (confirmRun) {
        const tempFile = await tempWrite(block.content, "script.sh");
        await execa`chmod +x ${tempFile}`;
        await execa({
          stdout: "inherit",
          stderr: "inherit",
          reject: false,
        })`${interpreterMap[lang]} ${tempFile}`;
      }
      break;
    default:
      console.log(
        `😬 hang in there, I still have to learn how to ${options?.action} a '${lang}' block.`
      );
      break;
  }
};

/**
 * Check whether the block should be permitted to run, commonly:
 * disabled=true, when=os.darwin, when=os.win32
 */
function isDisabled(options: Block["options"]) {
  // returns false or with a string containing the reason for being disabled
  if (options?.disabled) return colors.red("disabled=true");

  if (options?.when) {
    switch (options.when) {
      case "os.darwin":
        return os.platform() !== "darwin"
          ? colors.yellow("when!=os.darwin")
          : false;
      case "os.win32":
        return os.platform() !== "win32"
          ? colors.yellow("when!=os.win32")
          : false;
      default:
        break;
    }
  }
  return false;
}
