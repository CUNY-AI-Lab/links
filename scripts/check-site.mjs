#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
let localReferenceCount = 0;

function htmlFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...htmlFiles(file));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".html") files.push(file);
  }
  return files;
}

function isExternal(value) {
  return !value || value.startsWith("#") || value.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(value);
}

function checkReference(sourceFile, rawValue) {
  const value = rawValue.trim();
  if (isExternal(value)) return;

  const pathPart = value.split(/[?#]/, 1)[0];
  if (!pathPart) return;

  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    errors.push(`${relative(ROOT, sourceFile)}: invalid encoded local reference ${JSON.stringify(value)}`);
    return;
  }

  if (decoded.startsWith("/")) {
    errors.push(
      `${relative(ROOT, sourceFile)}: root-relative references do not resolve inside the /links/ Pages project: ${JSON.stringify(value)}`,
    );
    return;
  }

  const target = resolve(dirname(sourceFile), decoded);
  const targetRelative = relative(ROOT, target);
  if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
    errors.push(`${relative(ROOT, sourceFile)}: local reference escapes the site root: ${JSON.stringify(value)}`);
    return;
  }

  localReferenceCount += 1;
  if (!existsSync(target)) {
    errors.push(`${relative(ROOT, sourceFile)}: missing local reference ${JSON.stringify(value)}`);
  } else if (!statSync(target).isFile()) {
    const index = join(target, "index.html");
    if (!statSync(target).isDirectory() || !existsSync(index) || !statSync(index).isFile()) {
      errors.push(`${relative(ROOT, sourceFile)}: local reference is not a file or indexed directory ${JSON.stringify(value)}`);
    }
  }
}

function attributeValues(source, names) {
  const pattern = new RegExp(
    `\\b(?:${names.join("|")})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`,
    "gi",
  );
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function tagAttributeValues(source, names) {
  return [...source.matchAll(/<[^>]*>/g)].flatMap((match) => attributeValues(match[0], names));
}

function checkHtml(file) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    errors.push(`${relative(ROOT, file)}: could not read (${error.message})`);
    return;
  }

  const name = relative(ROOT, file);
  if (!/^\s*<!doctype html\b/i.test(source)) errors.push(`${name}: missing HTML doctype`);
  if (!/<html\b[^>]*>/i.test(source) || !/<\/html\s*>/i.test(source)) errors.push(`${name}: missing html root element`);
  if (!/<head\b[^>]*>/i.test(source) || !/<\/head\s*>/i.test(source)) errors.push(`${name}: missing head element`);
  if (!/<body\b[^>]*>/i.test(source) || !/<\/body\s*>/i.test(source)) errors.push(`${name}: missing body element`);
  const title = source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!title || !title[1].trim()) errors.push(`${name}: missing non-empty title`);

  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  const withoutScripts = withoutComments.replace(
    /(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi,
    "$1$2",
  );
  const markup = withoutScripts.replace(
    /(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi,
    "$1$2",
  );

  for (const value of tagAttributeValues(markup, ["href", "src", "poster", "data"])) {
    checkReference(file, value);
  }
  for (const value of tagAttributeValues(markup, ["srcset"])) {
    for (const candidate of value.split(",")) checkReference(file, candidate.trim().split(/\s+/, 1)[0]);
  }

  const cssSources = [
    ...[...withoutScripts.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(
      (match) => match[1],
    ),
    ...tagAttributeValues(markup, ["style"]),
  ];
  for (const css of cssSources) {
    const withoutCssComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of withoutCssComments.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      checkReference(file, match[2]);
    }
  }
}

const entrypoint = join(ROOT, "index.html");
if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) {
  errors.push("index.html: required site entrypoint is missing");
}

const files = htmlFiles(ROOT);
for (const file of files) checkHtml(file);

if (existsSync(entrypoint) && !/<main\b[^>]*>/i.test(readFileSync(entrypoint, "utf8"))) {
  errors.push("index.html: missing main content element");
}

if (errors.length) {
  console.error("Static site check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Static site check passed: ${files.length} HTML files, ${localReferenceCount} local references.`);
