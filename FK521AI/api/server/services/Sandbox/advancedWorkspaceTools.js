const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs/promises');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const mammoth = require('mammoth');
const fetch = require('node-fetch');
const {
  createWorkspaceError,
  resolveVirtualWorkspacePath,
  workspaceWrite,
  WORKSPACE_VIRTUAL_PATHS,
} = require('./workspaceFs');
const { createSandboxAccessError } = require('./requester');

const DEFAULT_MAX_TEXT_BYTES = Number(process.env.FK521_ADVANCED_TOOL_MAX_TEXT_BYTES || 5 * 1024 * 1024);
const DEFAULT_MAX_AST_NODES = Number(process.env.FK521_ADVANCED_TOOL_MAX_AST_NODES || 600);
const DEFAULT_MAX_SEARCH_FILES = Number(process.env.FK521_ADVANCED_TOOL_MAX_SEARCH_FILES || 1500);
const DEFAULT_MAX_MATCHES = Number(process.env.FK521_ADVANCED_TOOL_MAX_MATCHES || 200);
const DEFAULT_MAX_BINARY_STRINGS = Number(process.env.FK521_ADVANCED_TOOL_MAX_BINARY_STRINGS || 40);
const DEFAULT_NETWORK_TIMEOUT_MS = Number(process.env.FK521_ADVANCED_TOOL_NETWORK_TIMEOUT_MS || 5000);
const DEFAULT_TEST_TIMEOUT_MS = Number(process.env.FK521_ADVANCED_TOOL_TEST_TIMEOUT_MS || 120000);
const DEFAULT_OSV_TIMEOUT_MS = Number(process.env.FK521_ADVANCED_TOOL_OSV_TIMEOUT_MS || 10000);
const SYMLINK_ESCAPE_MESSAGE = 'Error: 符号链接越界，禁止访问工作区外部文件';

const PRIVATE_CIDR_PATTERNS = Object.freeze([
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^0\./,
]);

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.idea',
  '.vscode',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.turbo',
]);

const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.htm',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.java', '.kt', '.kts', '.go', '.rs', '.php', '.rb', '.sh', '.bash', '.zsh',
  '.sql', '.csv', '.tsv', '.env', '.properties', '.gradle', '.pom', '.lock', '.gitignore', '.dockerignore', '.tf', '.proto',
]);

const COMMON_LICENSE_PATTERNS = Object.freeze([
  { id: 'MIT', pattern: /permission is hereby granted, free of charge, to any person obtaining a copy/i },
  { id: 'Apache-2.0', pattern: /apache license[\s\S]{0,120}version 2\.0/i },
  { id: 'GPL-3.0-or-later', pattern: /gnu general public license[\s\S]{0,120}version 3/i },
  { id: 'GPL-2.0-or-later', pattern: /gnu general public license[\s\S]{0,120}version 2/i },
  { id: 'BSD-3-Clause', pattern: /redistribution and use in source and binary forms/i },
  { id: 'MPL-2.0', pattern: /mozilla public license[\s\S]{0,120}2\.0/i },
  { id: 'ISC', pattern: /permission to use, copy, modify, and\/or distribute this software for any purpose/i },
  { id: 'Unlicense', pattern: /this is free and unencumbered software released into the public domain/i },
]);

function toPosixPath(value = '') {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeListInput(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function getLowerExtension(targetPath = '') {
  return path.extname(String(targetPath || '')).toLowerCase();
}

function inferLanguageFromPath(targetPath = '', declaredLanguage = '') {
  const normalized = String(declaredLanguage || '').trim().toLowerCase();
  if (normalized) {
    return normalized;
  }

  const ext = getLowerExtension(targetPath);
  const mapping = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.xml': 'xml',
    '.html': 'html',
    '.htm': 'html',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.toml': 'toml',
  };
  return mapping[ext] || 'text';
}

function assertHostNetworkToolsEnabled(toolName = 'network_tool') {
  if (process.env.FK521_ENABLE_HOST_NETWORK_TOOLS === 'true') {
    return;
  }
  throw createSandboxAccessError(
    `宿主网络工具已禁用: ${toolName}`,
    'HOST_NETWORK_TOOLS_DISABLED',
    403,
  );
}

async function assertNotSymbolicLink(absolutePath, virtualPath) {
  const stats = await fs.lstat(absolutePath).catch((error) => {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (!stats) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    throw createWorkspaceError(SYMLINK_ESCAPE_MESSAGE, 'WORKSPACE_SYMLINK_ESCAPE', 403, {
      path: virtualPath,
      absolutePath,
    });
  }
  return stats;
}

async function resolveReadableFile(conversationId, inputPath) {
  const resolved = resolveVirtualWorkspacePath(conversationId, inputPath);
  if (resolved.isWorkspaceRoot) {
    throw createWorkspaceError('该接口需要具体文件路径，不能直接读取工作区根目录', 'WORKSPACE_FILE_REQUIRED', 400, {
      path: inputPath,
    });
  }
  await assertNotSymbolicLink(resolved.absolutePath, resolved.virtualPath);
  const stat = await fs.stat(resolved.absolutePath).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw createWorkspaceError('文件不存在', 'WORKSPACE_FILE_NOT_FOUND', 404, { path: resolved.virtualPath });
    }
    throw error;
  });
  if (!stat.isFile()) {
    throw createWorkspaceError('目标不是文件', 'WORKSPACE_FILE_EXPECTED', 400, { path: resolved.virtualPath });
  }
  return { resolved, stat };
}

async function resolveReadableDirectory(conversationId, inputPath) {
  const resolved = resolveVirtualWorkspacePath(conversationId, inputPath);
  if (resolved.isWorkspaceRoot) {
    return { resolved, stat: { isDirectory: () => true }, isWorkspaceRoot: true };
  }
  await assertNotSymbolicLink(resolved.absolutePath, resolved.virtualPath);
  const stat = await fs.stat(resolved.absolutePath).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw createWorkspaceError('目录不存在', 'WORKSPACE_DIRECTORY_NOT_FOUND', 404, { path: resolved.virtualPath });
    }
    throw error;
  });
  if (!stat.isDirectory()) {
    throw createWorkspaceError('目标不是目录', 'WORKSPACE_DIRECTORY_EXPECTED', 400, { path: resolved.virtualPath });
  }
  return { resolved, stat, isWorkspaceRoot: false };
}

async function readFileBuffer(conversationId, inputPath, maxBytes = DEFAULT_MAX_TEXT_BYTES) {
  const { resolved, stat } = await resolveReadableFile(conversationId, inputPath);
  if (stat.size > maxBytes) {
    throw createWorkspaceError('文件过大，超出当前接口读取上限', 'WORKSPACE_FILE_TOO_LARGE', 413, {
      path: resolved.virtualPath,
      size: stat.size,
      maxBytes,
    });
  }
  const buffer = await fs.readFile(resolved.absolutePath);
  return { resolved, stat, buffer };
}

function isLikelyBinary(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false;
  }
  let suspicious = 0;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
    if (byte < 7 || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / sample.length > 0.2;
}

function bufferToUtf8(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8').replace(/^\uFEFF/, '') : '';
}

function slicePreview(text, maxLength = 240) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function cleanHtmlToMarkdown(html = '') {
  let markdown = String(html || '');
  markdown = markdown.replace(/\r/g, '');
  markdown = markdown.replace(/<\s*br\s*\/?>/gi, '\n');
  markdown = markdown.replace(/<\s*\/p\s*>/gi, '\n\n');
  markdown = markdown.replace(/<\s*p[^>]*>/gi, '');
  markdown = markdown.replace(/<\s*h([1-6])[^>]*>([\s\S]*?)<\s*\/h\1\s*>/gi, (_m, depth, text) => `${'#'.repeat(Number(depth))} ${stripHtml(text)}\n\n`);
  markdown = markdown.replace(/<\s*strong[^>]*>([\s\S]*?)<\s*\/strong\s*>/gi, (_m, text) => `**${stripHtml(text)}**`);
  markdown = markdown.replace(/<\s*b[^>]*>([\s\S]*?)<\s*\/b\s*>/gi, (_m, text) => `**${stripHtml(text)}**`);
  markdown = markdown.replace(/<\s*em[^>]*>([\s\S]*?)<\s*\/em\s*>/gi, (_m, text) => `*${stripHtml(text)}*`);
  markdown = markdown.replace(/<\s*i[^>]*>([\s\S]*?)<\s*\/i\s*>/gi, (_m, text) => `*${stripHtml(text)}*`);
  markdown = markdown.replace(/<\s*code[^>]*>([\s\S]*?)<\s*\/code\s*>/gi, (_m, text) => `\`${stripHtml(text)}\``);
  markdown = markdown.replace(/<\s*li[^>]*>([\s\S]*?)<\s*\/li\s*>/gi, (_m, text) => `- ${stripHtml(text)}\n`);
  markdown = markdown.replace(/<\s*\/ul\s*>/gi, '\n');
  markdown = markdown.replace(/<\s*\/ol\s*>/gi, '\n');
  markdown = markdown.replace(/<\s*blockquote[^>]*>([\s\S]*?)<\s*\/blockquote\s*>/gi, (_m, text) => `> ${stripHtml(text)}\n\n`);
  markdown = markdown.replace(/<[^>]+>/g, '');
  markdown = decodeHtml(markdown);
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
  return markdown;
}

function decodeHtml(text = '') {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(html = '') {
  return decodeHtml(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function buildMarkdownAstFallback(markdown = '') {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const children = [];
  let inCodeBlock = false;
  let codeFence = '';
  let codeLanguage = '';
  let codeLines = [];
  let paragraph = [];
  let listBuffer = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const value = paragraph.join(' ').trim();
    if (value) {
      children.push({ type: 'paragraph', value });
    }
    paragraph = [];
  };

  const flushList = () => {
    if (listBuffer.length === 0) {
      return;
    }
    children.push({
      type: 'list',
      ordered: false,
      children: listBuffer.map((value) => ({ type: 'listItem', value })),
    });
    listBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine ?? '';
    const trimmed = line.trim();

    if (inCodeBlock) {
      if (trimmed.startsWith(codeFence)) {
        children.push({ type: 'code', lang: codeLanguage || null, value: codeLines.join('\n') });
        inCodeBlock = false;
        codeFence = '';
        codeLanguage = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fenceMatch = trimmed.match(/^(```+|~~~+)(.*)$/);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      inCodeBlock = true;
      codeFence = fenceMatch[1];
      codeLanguage = fenceMatch[2].trim();
      codeLines = [];
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      children.push({ type: 'heading', depth: headingMatch[1].length, value: headingMatch[2].trim() });
      continue;
    }

    const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      listBuffer.push(listMatch[1].trim());
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();

  return {
    type: 'root',
    children,
  };
}

function buildObjectAst(value, options = {}, state = { nodes: 0 }) {
  const maxNodes = Number(options.maxNodes || DEFAULT_MAX_AST_NODES);
  if (state.nodes >= maxNodes) {
    return { type: 'truncated', reason: 'max_nodes_reached' };
  }
  state.nodes += 1;

  if (value === null) {
    return { type: 'null', value: null };
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      children: value.slice(0, 50).map((item) => buildObjectAst(item, options, state)),
      truncated: value.length > 50,
    };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return {
      type: 'object',
      properties: entries.slice(0, 100).map(([key, child]) => ({
        key,
        value: buildObjectAst(child, options, state),
      })),
      truncated: entries.length > 100,
    };
  }
  return { type: typeof value, value };
}

function tryRequire(moduleName) {
  try {
    return require(moduleName);
  } catch (_error) {
    return null;
  }
}

function summarizeTsAstNode(ts, node, sourceFile, state, maxNodes) {
  if (!node || state.count >= maxNodes) {
    return { type: 'truncated', reason: 'max_nodes_reached' };
  }
  state.count += 1;
  const kind = ts.SyntaxKind[node.kind] || 'Unknown';
  const item = {
    type: kind,
    start: node.pos,
    end: node.end,
  };

  if (node.name && typeof node.name.getText === 'function') {
    item.name = node.name.getText(sourceFile).slice(0, 200);
  }
  if (node.text != null && typeof node.text === 'string') {
    item.text = slicePreview(node.text, 120);
  }
  if (typeof node.getText === 'function' && ['Identifier', 'StringLiteral', 'NumericLiteral'].includes(kind)) {
    item.value = slicePreview(node.getText(sourceFile), 120);
  }

  const children = [];
  node.forEachChild((child) => {
    if (state.count >= maxNodes) {
      return;
    }
    children.push(summarizeTsAstNode(ts, child, sourceFile, state, maxNodes));
  });
  if (children.length > 0) {
    item.children = children;
  }
  return item;
}

function parseWithTypeScript(code, language, fileName, maxNodes = DEFAULT_MAX_AST_NODES) {
  const ts = tryRequire('typescript');
  if (!ts) {
    throw createWorkspaceError('缺少 TypeScript 解析器依赖，无法解析 JS/TS AST', 'CODE_AST_TYPESCRIPT_NOT_AVAILABLE', 500);
  }

  const scriptKindMap = {
    javascript: ts.ScriptKind.JS,
    jsx: ts.ScriptKind.JSX,
    typescript: ts.ScriptKind.TS,
    tsx: ts.ScriptKind.TSX,
  };
  const normalized = String(language || '').toLowerCase();
  const scriptKind = scriptKindMap[normalized] || scriptKindMap.typescript;
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, scriptKind);
  const state = { count: 0 };
  return {
    parser: 'typescript',
    language: normalized,
    ast: summarizeTsAstNode(ts, sourceFile, sourceFile, state, maxNodes),
    nodeCount: state.count,
    parseDiagnostics: Array.isArray(sourceFile.parseDiagnostics)
      ? sourceFile.parseDiagnostics.map((diag) => ({
          code: diag.code,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
          start: diag.start,
          length: diag.length,
        }))
      : [],
  };
}

function parsePythonAst(code, maxNodes = DEFAULT_MAX_AST_NODES) {
  const script = `
import ast
import json
import sys
MAX_NODES = int(sys.argv[1])
source = sys.stdin.read()
state = {'count': 0}

def walk(node):
    if state['count'] >= MAX_NODES:
        return {'type': 'truncated', 'reason': 'max_nodes_reached'}
    state['count'] += 1
    if isinstance(node, ast.AST):
        item = {'type': node.__class__.__name__}
        for field, value in ast.iter_fields(node):
            if isinstance(value, ast.AST):
                item[field] = walk(value)
            elif isinstance(value, list):
                children = []
                for child in value[:100]:
                    if isinstance(child, ast.AST):
                        children.append(walk(child))
                    else:
                        children.append(child)
                item[field] = children
                if len(value) > 100:
                    item.setdefault('truncated_fields', []).append(field)
            elif isinstance(value, (str, int, float, bool)) or value is None:
                item[field] = value
        if hasattr(node, 'lineno'):
            item['lineno'] = getattr(node, 'lineno', None)
            item['col_offset'] = getattr(node, 'col_offset', None)
        return item
    if isinstance(node, list):
        return [walk(child) for child in node[:100]]
    return node

try:
    tree = ast.parse(source)
    print(json.dumps({'parser': 'python-ast', 'language': 'python', 'nodeCount': state['count'], 'ast': walk(tree)}))
except SyntaxError as exc:
    print(json.dumps({'parser': 'python-ast', 'language': 'python', 'error': {'message': str(exc), 'lineno': exc.lineno, 'offset': exc.offset}}))
    sys.exit(0)
`;

  const result = spawnSync('python3', ['-c', script, String(maxNodes)], {
    input: code,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw createWorkspaceError(`Python AST 解析失败: ${result.error.message}`, 'CODE_AST_PYTHON_FAILED', 500);
  }
  const stdout = String(result.stdout || '').trim();
  if (!stdout) {
    throw createWorkspaceError('Python AST 解析器未返回结果', 'CODE_AST_PYTHON_EMPTY', 500, {
      stderr: String(result.stderr || '').trim(),
    });
  }
  return JSON.parse(stdout);
}

async function parsePdfBuffer(buffer) {
  let pdfjsLib = null;
  try {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (_error) {
    throw createWorkspaceError('缺少 PDF 解析依赖 pdfjs-dist', 'PDF_PARSE_DEPENDENCY_MISSING', 500);
  }

  const loadingTask = pdfjsLib.getDocument({
    data: buffer,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pages = [];
  let fullText = '';

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const items = Array.isArray(textContent.items) ? textContent.items : [];
    const fragments = items
      .map((item) => ({
        text: typeof item.str === 'string' ? item.str : '',
        x: Array.isArray(item.transform) ? Number(item.transform[4] || 0) : 0,
        y: Array.isArray(item.transform) ? Number(item.transform[5] || 0) : 0,
      }))
      .filter((item) => item.text);

    fragments.sort((a, b) => {
      const yDiff = Math.abs(b.y - a.y);
      if (yDiff > 2) {
        return b.y - a.y;
      }
      return a.x - b.x;
    });

    const lines = [];
    let currentY = null;
    let currentLine = [];
    for (const fragment of fragments) {
      if (currentY == null || Math.abs(fragment.y - currentY) <= 2) {
        currentLine.push(fragment.text);
        currentY = currentY == null ? fragment.y : currentY;
      } else {
        lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
        currentLine = [fragment.text];
        currentY = fragment.y;
      }
    }
    if (currentLine.length > 0) {
      lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
    }

    const pageText = lines.filter(Boolean).join('\n');
    fullText += (fullText ? '\n\n' : '') + pageText;
    pages.push({ pageNumber, text: pageText, lineCount: lines.filter(Boolean).length, itemCount: fragments.length });
  }

  return {
    parser: 'pdfjs-dist',
    pageCount: pdf.numPages,
    text: fullText.trim(),
    pages,
  };
}

function buildDocxSections(text = '') {
  const paragraphs = String(text || '')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((value) => value.trim())
    .filter(Boolean);
  return paragraphs.map((value, index) => ({ index: index + 1, text: value }));
}

async function walkWorkspaceFiles({
  conversationId,
  rootPath,
  maxFiles = DEFAULT_MAX_SEARCH_FILES,
  includeExtensions = [],
  includeHidden = false,
}) {
  const { resolved } = await resolveReadableDirectory(conversationId, rootPath);
  const normalizedExts = new Set(normalizeListInput(includeExtensions).map((ext) => ext.toLowerCase()));
  const files = [];
  const queue = [];

  if (resolved.isWorkspaceRoot) {
    for (const virtualPath of Object.values(WORKSPACE_VIRTUAL_PATHS)) {
      if (virtualPath === WORKSPACE_VIRTUAL_PATHS.root || virtualPath === WORKSPACE_VIRTUAL_PATHS.uploadManifest) {
        continue;
      }
      try {
        const childResolved = resolveVirtualWorkspacePath(conversationId, virtualPath);
        const childStat = await fs.stat(childResolved.absolutePath).catch(() => null);
        if (childStat?.isDirectory()) {
          queue.push({ absolutePath: childResolved.absolutePath, virtualPath: childResolved.virtualPath });
        }
      } catch (_error) {
        // ignore unavailable roots
      }
    }
  } else {
    queue.push({ absolutePath: resolved.absolutePath, virtualPath: resolved.virtualPath });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current.absolutePath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) {
        continue;
      }
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(current.absolutePath, entry.name);
      const virtualPath = `${current.virtualPath.replace(/\/$/, '')}/${entry.name}`.replace(/\/+/g, '/');
      await assertNotSymbolicLink(absolutePath, virtualPath);
      if (entry.isDirectory()) {
        queue.push({ absolutePath, virtualPath });
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (normalizedExts.size > 0 && !normalizedExts.has(getLowerExtension(entry.name))) {
        continue;
      }
      files.push({ absolutePath, virtualPath, extension: getLowerExtension(entry.name), name: entry.name });
      if (files.length >= maxFiles) {
        return { truncated: true, files };
      }
    }
  }

  return { truncated: false, files };
}

function buildRegex(pattern, caseSensitive = false) {
  try {
    return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
  } catch (error) {
    throw createWorkspaceError(`无效正则表达式: ${error.message}`, 'WORKSPACE_INVALID_REGEX', 400, {
      pattern,
    });
  }
}

function scoreFuzzyMatch(query, candidate) {
  const q = String(query || '').toLowerCase();
  const c = String(candidate || '').toLowerCase();
  if (!q || !c) {
    return 0;
  }
  if (c === q) {
    return 1;
  }
  if (c.startsWith(q)) {
    return 0.92;
  }
  if (c.includes(q)) {
    return 0.84;
  }
  let qi = 0;
  let matched = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci += 1) {
    if (c[ci] === q[qi]) {
      matched += 1;
      qi += 1;
    }
  }
  return matched / q.length * 0.65;
}

function computeEntropy(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return 0;
  }
  const counts = new Array(256).fill(0);
  for (const byte of buffer) {
    counts[byte] += 1;
  }
  let entropy = 0;
  for (const count of counts) {
    if (!count) {
      continue;
    }
    const p = count / buffer.length;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(4));
}

function extractPrintableStrings(buffer, minLength = 4, maxStrings = DEFAULT_MAX_BINARY_STRINGS) {
  const matches = [];
  let current = '';
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLength) {
        matches.push(current);
        if (matches.length >= maxStrings) {
          break;
        }
      }
      current = '';
    }
  }
  if (current.length >= minLength && matches.length < maxStrings) {
    matches.push(current);
  }
  return matches;
}

function identifyBinaryFormat(buffer, targetPath = '') {
  const ext = getLowerExtension(targetPath);
  if (buffer.length >= 4) {
    const magic = buffer.subarray(0, 4).toString('hex');
    if (magic === '7f454c46') {
      return 'ELF';
    }
    if (magic === '4d5a9000' || buffer.subarray(0, 2).toString('hex') === '4d5a') {
      return 'PE';
    }
    if (magic === 'cafebabe') {
      return 'Mach-O/Fat';
    }
    if (['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe'].includes(magic)) {
      return 'Mach-O';
    }
    if (buffer.subarray(0, 4).toString('ascii') === '%PDF') {
      return 'PDF';
    }
    if (buffer.subarray(0, 2).toString('hex') === '504b') {
      return 'ZIP';
    }
  }
  const mapping = {
    '.so': 'Shared Object',
    '.dll': 'DLL',
    '.exe': 'Executable',
    '.bin': 'Binary',
    '.dylib': 'Dynamic Library',
    '.class': 'Java Class',
    '.jar': 'JAR',
  };
  return mapping[ext] || 'Unknown binary';
}

function isPrivateIPv4(host = '') {
  return PRIVATE_CIDR_PATTERNS.some((pattern) => pattern.test(host));
}

function isPrivateIPv6(host = '') {
  const value = String(host || '').toLowerCase();
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
}

async function assertPublicRemoteHost(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) {
    throw createSandboxAccessError('缺少目标主机', 'NETWORK_HOST_REQUIRED', 400);
  }
  if (['localhost', 'host.docker.internal'].includes(normalized)) {
    throw createSandboxAccessError('禁止访问本地或宿主机地址', 'NETWORK_HOST_BLOCKED', 403);
  }

  const ipFamily = net.isIP(normalized);
  if (ipFamily === 4 && isPrivateIPv4(normalized)) {
    throw createSandboxAccessError('禁止访问私有 IPv4 地址', 'NETWORK_PRIVATE_IPV4', 403);
  }
  if (ipFamily === 6 && isPrivateIPv6(normalized)) {
    throw createSandboxAccessError('禁止访问私有 IPv6 地址', 'NETWORK_PRIVATE_IPV6', 403);
  }

  if (ipFamily) {
    return { hostname: normalized, addresses: [{ address: normalized, family: ipFamily }] };
  }

  const addresses = await dns.lookup(normalized, { all: true }).catch((error) => {
    throw createSandboxAccessError(`DNS 解析失败: ${error.message}`, 'NETWORK_DNS_LOOKUP_FAILED', 400, { hostname: normalized });
  });
  if (!addresses.length) {
    throw createSandboxAccessError('DNS 未返回任何地址', 'NETWORK_DNS_EMPTY', 400, { hostname: normalized });
  }
  for (const record of addresses) {
    if ((record.family === 4 && isPrivateIPv4(record.address)) || (record.family === 6 && isPrivateIPv6(record.address))) {
      throw createSandboxAccessError('目标主机解析到私网地址，已阻止访问', 'NETWORK_PRIVATE_RESOLUTION', 403, {
        hostname: normalized,
        address: record.address,
      });
    }
  }
  return { hostname: normalized, addresses };
}

async function headRequest(url, timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      follow: 0,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function parseRequirementsText(text = '') {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const dependencies = [];
  const includes = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('-r ') || line.startsWith('--requirement ')) {
      includes.push(line.replace(/^(?:-r|--requirement)\s+/, '').trim());
      continue;
    }
    const editable = line.startsWith('-e ');
    const normalized = editable ? line.slice(3).trim() : line;
    const match = normalized.match(/^([A-Za-z0-9._\-\[\]]+)(?:\s*(==|~=|!=|<=|>=|<|>)\s*([^;\s]+))?(?:\s*;\s*(.+))?$/);
    if (match) {
      dependencies.push({
        name: match[1],
        version: match[3] || null,
        operator: match[2] || null,
        marker: match[4] || null,
        editable,
      });
      continue;
    }
    dependencies.push({
      name: normalized,
      version: null,
      operator: null,
      marker: null,
      editable,
      raw: normalized,
    });
  }

  return { dependencies, includes };
}

function parsePackageJsonObject(pkg = {}) {
  const groups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const dependencies = [];
  for (const group of groups) {
    const source = pkg[group] && typeof pkg[group] === 'object' ? pkg[group] : {};
    for (const [name, version] of Object.entries(source)) {
      dependencies.push({
        name,
        version: String(version),
        scope: group,
      });
    }
  }
  return {
    packageName: pkg.name || null,
    packageVersion: pkg.version || null,
    license: pkg.license || null,
    dependencies,
  };
}

function parsePomXmlText(text = '') {
  const xml = String(text || '');
  const dependencyRegex = /<dependency>([\s\S]*?)<\/dependency>/gi;
  const properties = {};
  const propertyRegex = /<properties>([\s\S]*?)<\/properties>/i;
  const propertyBlock = xml.match(propertyRegex)?.[1] || '';
  for (const match of propertyBlock.matchAll(/<([A-Za-z0-9_.-]+)>([^<]+)<\/\1>/g)) {
    properties[match[1]] = match[2].trim();
  }

  const dependencies = [];
  for (const match of xml.matchAll(dependencyRegex)) {
    const body = match[1];
    const groupId = body.match(/<groupId>([^<]+)<\/groupId>/i)?.[1]?.trim() || null;
    const artifactId = body.match(/<artifactId>([^<]+)<\/artifactId>/i)?.[1]?.trim() || null;
    let version = body.match(/<version>([^<]+)<\/version>/i)?.[1]?.trim() || null;
    const scope = body.match(/<scope>([^<]+)<\/scope>/i)?.[1]?.trim() || 'compile';
    if (version?.startsWith('${') && version.endsWith('}')) {
      const key = version.slice(2, -1);
      version = properties[key] || version;
    }
    if (groupId && artifactId) {
      dependencies.push({ groupId, artifactId, version, scope });
    }
  }

  const projectVersion = xml.match(/<project[\s\S]*?<version>([^<]+)<\/version>/i)?.[1]?.trim() || null;
  const artifactId = xml.match(/<project[\s\S]*?<artifactId>([^<]+)<\/artifactId>/i)?.[1]?.trim() || null;
  const groupId = xml.match(/<project[\s\S]*?<groupId>([^<]+)<\/groupId>/i)?.[1]?.trim() || null;

  return {
    groupId,
    artifactId,
    version: projectVersion,
    properties,
    dependencies,
  };
}

function parseCargoTomlText(text = '') {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let section = '';
  const dependencies = [];
  const metadata = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }

    if (section === 'package') {
      const packageField = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/);
      if (packageField) {
        metadata[packageField[1]] = packageField[2];
      }
      continue;
    }

    if (!['dependencies', 'dev-dependencies', 'build-dependencies'].includes(section)) {
      continue;
    }

    const keyValue = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyValue) {
      continue;
    }

    const name = keyValue[1];
    const rawValue = keyValue[2].trim();
    let version = null;
    let detail = null;

    if (rawValue.startsWith('"')) {
      version = rawValue.replace(/^"|"$/g, '');
    } else if (rawValue.startsWith('{')) {
      const versionMatch = rawValue.match(/version\s*=\s*"([^"]+)"/);
      version = versionMatch?.[1] || null;
      detail = rawValue;
    }

    dependencies.push({ name, version, scope: section, detail });
  }

  return {
    packageName: metadata.name || null,
    packageVersion: metadata.version || null,
    license: metadata.license || null,
    dependencies,
  };
}

function parsePyProjectTomlText(text = '') {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let section = '';
  const dependencies = [];
  const metadata = {};
  let inProjectDependencies = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      inProjectDependencies = false;
      continue;
    }

    if (section === 'project') {
      const field = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/);
      if (field) {
        metadata[field[1]] = field[2];
        continue;
      }
      if (line.startsWith('dependencies = [')) {
        inProjectDependencies = true;
        continue;
      }
      if (inProjectDependencies) {
        if (line.startsWith(']')) {
          inProjectDependencies = false;
          continue;
        }
        const dep = line.replace(/^[",\s]+|[",\s]+$/g, '');
        if (dep) {
          const parsed = parseRequirementsText(dep).dependencies[0];
          if (parsed) {
            dependencies.push({ ...parsed, scope: 'project.dependencies' });
          }
        }
      }
      continue;
    }

    if (section === 'tool.poetry.dependencies' || section === 'tool.poetry.group.dev.dependencies') {
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if (!match) {
        continue;
      }
      const name = match[1];
      const rawValue = match[2].trim();
      let version = null;
      if (rawValue.startsWith('"')) {
        version = rawValue.replace(/^"|"$/g, '');
      } else if (rawValue.startsWith('{')) {
        version = rawValue.match(/version\s*=\s*"([^"]+)"/)?.[1] || null;
      }
      dependencies.push({ name, version, scope: section, raw: rawValue });
    }
  }

  return {
    packageName: metadata.name || null,
    packageVersion: metadata.version || null,
    license: metadata.license || null,
    dependencies,
  };
}

function buildComponentPurl(component = {}) {
  const ecosystem = String(component.ecosystem || '').toLowerCase();
  const versionSuffix = component.version ? `@${component.version}` : '';
  const name = component.name || component.artifactId || component.packageName;
  if (!name) {
    return null;
  }
  if (ecosystem === 'npm') {
    return `pkg:npm/${name}${versionSuffix}`;
  }
  if (ecosystem === 'pypi') {
    return `pkg:pypi/${name}${versionSuffix}`;
  }
  if (ecosystem === 'maven' && component.group) {
    return `pkg:maven/${component.group}/${name}${versionSuffix}`;
  }
  if (ecosystem === 'cargo') {
    return `pkg:cargo/${name}${versionSuffix}`;
  }
  return null;
}

function normalizeSbomComponents(records = []) {
  return records.map((record) => ({
    type: 'library',
    name: record.name || record.artifactId,
    version: record.version || null,
    scope: record.scope || null,
    group: record.groupId || record.group || null,
    ecosystem: record.ecosystem,
    purl: buildComponentPurl({
      ecosystem: record.ecosystem,
      name: record.name || record.artifactId,
      version: record.version || null,
      group: record.groupId || record.group || null,
    }),
    properties: [
      { name: 'source.path', value: record.sourcePath || '' },
      { name: 'source.type', value: record.sourceType || '' },
    ].filter((item) => item.value),
  }));
}

async function maybeWriteJsonArtifact({ conversationId, outputPath, payload }) {
  if (!outputPath) {
    return null;
  }
  await workspaceWrite({
    conversationId,
    path: outputPath,
    content: JSON.stringify(payload, null, 2),
    overwrite: true,
    encoding: 'utf8',
  });
  return outputPath;
}

async function maybeWriteTextArtifact({ conversationId, outputPath, text }) {
  if (!outputPath) {
    return null;
  }
  await workspaceWrite({
    conversationId,
    path: outputPath,
    content: String(text || ''),
    overwrite: true,
    encoding: 'utf8',
  });
  return outputPath;
}

async function pdfParse({ conversationId, path: targetPath }) {
  const { resolved, stat, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
  const result = await parsePdfBuffer(buffer);
  return {
    path: resolved.virtualPath,
    size: stat.size,
    ...result,
  };
}

async function docxParse({ conversationId, path: targetPath }) {
  const { resolved, stat, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
  const extracted = await mammoth.extractRawText({ buffer });
  const html = await mammoth.convertToHtml({ buffer });
  const text = String(extracted.value || '').trim();
  return {
    path: resolved.virtualPath,
    size: stat.size,
    parser: 'mammoth',
    text,
    sections: buildDocxSections(text),
    messages: extracted.messages || [],
    htmlPreview: slicePreview(String(html.value || ''), 500),
  };
}

async function markdownAst({ conversationId, path: targetPath = null, text = null }) {
  let markdown = text;
  let sourcePath = null;
  if (targetPath) {
    const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
    markdown = bufferToUtf8(buffer);
    sourcePath = resolved.virtualPath;
  }
  if (typeof markdown !== 'string') {
    throw createWorkspaceError('必须提供 Markdown 文本或文件路径', 'MARKDOWN_AST_INPUT_REQUIRED', 400);
  }

  let ast = null;
  let parser = 'fallback';
  try {
    const unified = tryRequire('unified');
    const remarkParse = tryRequire('remark-parse');
    if (unified && remarkParse) {
      const processor = unified.unified ? unified.unified() : unified();
      ast = processor.use(remarkParse).parse(markdown);
      parser = 'remark';
    }
  } catch (_error) {
    ast = null;
  }

  if (!ast) {
    ast = buildMarkdownAstFallback(markdown);
  }

  return {
    path: sourcePath,
    parser,
    ast,
    excerpt: slicePreview(markdown, 300),
  };
}

async function codeAst({ conversationId, path: targetPath = null, code = null, language = null, maxNodes = DEFAULT_MAX_AST_NODES }) {
  let source = code;
  let sourcePath = null;
  if (targetPath) {
    const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
    source = bufferToUtf8(buffer);
    sourcePath = resolved.virtualPath;
  }
  if (typeof source !== 'string') {
    throw createWorkspaceError('必须提供源码文本或文件路径', 'CODE_AST_INPUT_REQUIRED', 400);
  }

  const inferredLanguage = inferLanguageFromPath(sourcePath || '', language);
  let result = null;

  if (['javascript', 'typescript', 'jsx', 'tsx'].includes(inferredLanguage)) {
    result = parseWithTypeScript(source, inferredLanguage, sourcePath || `inline.${inferredLanguage}`, maxNodes);
  } else if (inferredLanguage === 'python') {
    result = parsePythonAst(source, maxNodes);
  } else if (inferredLanguage === 'json') {
    result = {
      parser: 'json',
      language: inferredLanguage,
      ast: buildObjectAst(JSON.parse(source), { maxNodes }),
    };
  } else if (inferredLanguage === 'yaml') {
    result = {
      parser: 'yaml',
      language: inferredLanguage,
      ast: buildObjectAst(yaml.load(source), { maxNodes }),
    };
  } else if (['xml', 'html'].includes(inferredLanguage)) {
    result = {
      parser: 'xml-lite',
      language: inferredLanguage,
      ast: {
        type: 'document',
        nodes: Array.from(source.matchAll(/<([A-Za-z0-9:_-]+)(?:\s+[^>]*)?>/g)).slice(0, maxNodes).map((match) => ({
          type: 'element',
          name: match[1],
          index: match.index,
        })),
      },
    };
  } else {
    result = {
      parser: 'outline-fallback',
      language: inferredLanguage,
      ast: {
        type: 'text',
        lines: source.split(/\r?\n/).slice(0, 200).map((line, index) => ({
          line: index + 1,
          text: line,
        })),
      },
      warning: `当前语言 ${inferredLanguage} 未接入专用 AST 解析器，已返回结构化文本轮廓`,
    };
  }

  return {
    path: sourcePath,
    ...result,
  };
}

async function convertPdfToText({ conversationId, path: targetPath, outputPath = null }) {
  const parsed = await pdfParse({ conversationId, path: targetPath });
  if (outputPath) {
    await maybeWriteTextArtifact({ conversationId, outputPath, text: parsed.text });
  }
  return outputPath
    ? { sourcePath: parsed.path, path: outputPath, pageCount: parsed.pageCount, bytes: Buffer.byteLength(parsed.text || '', 'utf8') }
    : { sourcePath: parsed.path, text: parsed.text, pageCount: parsed.pageCount };
}

async function convertDocxToMd({ conversationId, path: targetPath, outputPath = null }) {
  const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
  const html = await mammoth.convertToHtml({ buffer });
  const markdown = cleanHtmlToMarkdown(html.value || '');
  if (outputPath) {
    await maybeWriteTextArtifact({ conversationId, outputPath, text: markdown });
  }
  return outputPath
    ? { sourcePath: resolved.virtualPath, path: outputPath, bytes: Buffer.byteLength(markdown, 'utf8') }
    : { sourcePath: resolved.virtualPath, markdown };
}

async function jsonToYaml({ conversationId, path: targetPath = null, text = null, outputPath = null }) {
  let source = text;
  let sourcePath = null;
  if (targetPath) {
    const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
    source = bufferToUtf8(buffer);
    sourcePath = resolved.virtualPath;
  }
  const value = JSON.parse(source);
  const rendered = yaml.dump(value, { noRefs: true, lineWidth: 120 });
  if (outputPath) {
    await maybeWriteTextArtifact({ conversationId, outputPath, text: rendered });
  }
  return outputPath ? { sourcePath, path: outputPath } : { sourcePath, yaml: rendered };
}

async function yamlToJson({ conversationId, path: targetPath = null, text = null, outputPath = null }) {
  let source = text;
  let sourcePath = null;
  if (targetPath) {
    const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
    source = bufferToUtf8(buffer);
    sourcePath = resolved.virtualPath;
  }
  const value = yaml.load(source);
  const rendered = JSON.stringify(value, null, 2);
  if (outputPath) {
    await maybeWriteTextArtifact({ conversationId, outputPath, text: rendered });
  }
  return outputPath ? { sourcePath, path: outputPath } : { sourcePath, json: rendered };
}

async function workspaceGrep({
  conversationId,
  rootPath = '/workspace',
  query = null,
  regex = null,
  caseSensitive = false,
  includeExtensions = [],
  maxMatches = DEFAULT_MAX_MATCHES,
  maxFiles = DEFAULT_MAX_SEARCH_FILES,
}) {
  if (!query && !regex) {
    throw createWorkspaceError('必须提供 query 或 regex', 'WORKSPACE_GREP_QUERY_REQUIRED', 400);
  }
  const compiledRegex = regex
    ? buildRegex(regex, caseSensitive)
    : buildRegex(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive);

  const walked = await walkWorkspaceFiles({
    conversationId,
    rootPath,
    maxFiles,
    includeExtensions,
  });

  const matches = [];
  let scannedFiles = 0;
  let skippedBinaryFiles = 0;

  for (const file of walked.files) {
    if (matches.length >= maxMatches) {
      break;
    }
    const buffer = await fs.readFile(file.absolutePath).catch(() => null);
    if (!buffer) {
      continue;
    }
    scannedFiles += 1;
    if (isLikelyBinary(buffer)) {
      skippedBinaryFiles += 1;
      continue;
    }
    const text = bufferToUtf8(buffer);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < maxMatches; i += 1) {
      const line = lines[i];
      compiledRegex.lastIndex = 0;
      const lineMatches = [...line.matchAll(compiledRegex)];
      for (const lineMatch of lineMatches) {
        matches.push({
          path: file.virtualPath,
          line: i + 1,
          column: (lineMatch.index || 0) + 1,
          match: lineMatch[0],
          excerpt: slicePreview(line, 220),
        });
        if (matches.length >= maxMatches) {
          break;
        }
      }
    }
  }

  return {
    rootPath,
    mode: regex ? 'regex' : 'string',
    query: regex || query,
    scannedFiles,
    skippedBinaryFiles,
    matches,
    truncated: matches.length >= maxMatches || walked.truncated,
  };
}

async function searchInFiles(args) {
  return await workspaceGrep(args);
}

async function fuzzySearch({
  conversationId,
  rootPath = '/workspace',
  query,
  includeExtensions = [],
  maxResults = 50,
  maxFiles = DEFAULT_MAX_SEARCH_FILES,
}) {
  if (!query) {
    throw createWorkspaceError('必须提供 query', 'FUZZY_SEARCH_QUERY_REQUIRED', 400);
  }
  const walked = await walkWorkspaceFiles({
    conversationId,
    rootPath,
    maxFiles,
    includeExtensions,
    includeHidden: false,
  });

  const results = [];
  for (const file of walked.files) {
    const pathScore = scoreFuzzyMatch(query, file.virtualPath);
    const nameScore = scoreFuzzyMatch(query, file.name);
    let contentScore = 0;
    let preview = '';
    if (Math.max(pathScore, nameScore) < 0.75) {
      const buffer = await fs.readFile(file.absolutePath).catch(() => null);
      if (buffer && !isLikelyBinary(buffer)) {
        const text = bufferToUtf8(buffer);
        preview = slicePreview(text, 160);
        contentScore = scoreFuzzyMatch(query, text.slice(0, 4000));
      }
    }
    const score = Math.max(pathScore, nameScore, contentScore * 0.9);
    if (score >= 0.35) {
      results.push({
        path: file.virtualPath,
        score: Number(score.toFixed(4)),
        preview,
      });
    }
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    rootPath,
    query,
    results: results.slice(0, maxResults),
    truncated: results.length > maxResults || walked.truncated,
  };
}

async function parsePackageJson({ conversationId, path: targetPath }) {
  const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
  const pkg = JSON.parse(bufferToUtf8(buffer));
  return {
    path: resolved.virtualPath,
    ecosystem: 'npm',
    ...parsePackageJsonObject(pkg),
  };
}

async function listPipRequirements({ conversationId, path: targetPath }) {
  const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
  const parsed = parseRequirementsText(bufferToUtf8(buffer));
  return {
    path: resolved.virtualPath,
    ecosystem: 'pypi',
    ...parsed,
  };
}

async function scanMavenPom({ conversationId, path: targetPath }) {
  const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
  return {
    path: resolved.virtualPath,
    ecosystem: 'maven',
    ...parsePomXmlText(bufferToUtf8(buffer)),
  };
}

async function scanCargoToml({ conversationId, path: targetPath }) {
  const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
  return {
    path: resolved.virtualPath,
    ecosystem: 'cargo',
    ...parseCargoTomlText(bufferToUtf8(buffer)),
  };
}

async function detectDependencies({ conversationId, rootPath = '/workspace', maxFiles = DEFAULT_MAX_SEARCH_FILES }) {
  const walked = await walkWorkspaceFiles({ conversationId, rootPath, maxFiles, includeHidden: true });
  const manifests = [];
  const dependencies = [];

  for (const file of walked.files) {
    const lowerName = file.name.toLowerCase();
    try {
      if (lowerName === 'package.json') {
        const parsed = await parsePackageJson({ conversationId, path: file.virtualPath });
        manifests.push({ path: parsed.path, ecosystem: 'npm', packageName: parsed.packageName });
        dependencies.push(...parsed.dependencies.map((dep) => ({ ...dep, ecosystem: 'npm', sourcePath: parsed.path, sourceType: 'package.json' })));
      } else if (lowerName === 'requirements.txt' || lowerName.endsWith('.requirements.txt')) {
        const parsed = await listPipRequirements({ conversationId, path: file.virtualPath });
        manifests.push({ path: parsed.path, ecosystem: 'pypi', includes: parsed.includes });
        dependencies.push(...parsed.dependencies.map((dep) => ({ ...dep, ecosystem: 'pypi', sourcePath: parsed.path, sourceType: 'requirements.txt' })));
      } else if (lowerName === 'pyproject.toml') {
        const { buffer } = await readFileBuffer(conversationId, file.virtualPath, DEFAULT_MAX_TEXT_BYTES);
        const parsed = parsePyProjectTomlText(bufferToUtf8(buffer));
        manifests.push({ path: file.virtualPath, ecosystem: 'pypi', packageName: parsed.packageName });
        dependencies.push(...parsed.dependencies.map((dep) => ({ ...dep, ecosystem: 'pypi', sourcePath: file.virtualPath, sourceType: 'pyproject.toml' })));
      } else if (lowerName === 'pom.xml') {
        const parsed = await scanMavenPom({ conversationId, path: file.virtualPath });
        manifests.push({ path: parsed.path, ecosystem: 'maven', artifactId: parsed.artifactId });
        dependencies.push(...parsed.dependencies.map((dep) => ({ ...dep, ecosystem: 'maven', name: dep.artifactId, sourcePath: parsed.path, sourceType: 'pom.xml' })));
      } else if (lowerName === 'cargo.toml') {
        const parsed = await scanCargoToml({ conversationId, path: file.virtualPath });
        manifests.push({ path: parsed.path, ecosystem: 'cargo', packageName: parsed.packageName });
        dependencies.push(...parsed.dependencies.map((dep) => ({ ...dep, ecosystem: 'cargo', sourcePath: parsed.path, sourceType: 'cargo.toml' })));
      }
    } catch (error) {
      manifests.push({ path: file.virtualPath, ecosystem: 'unknown', error: error.message });
    }
  }

  return {
    rootPath,
    manifests,
    dependencies,
    totalDependencies: dependencies.length,
    truncated: walked.truncated,
  };
}

async function sbomGenerate({ conversationId, rootPath = '/workspace', outputPath = null }) {
  const detected = await detectDependencies({ conversationId, rootPath });
  const components = normalizeSbomComponents(detected.dependencies);
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: 'FK521AI', name: 'advancedWorkspaceTools', version: '1.0.0' }],
      component: {
        type: 'application',
        name: path.basename(String(rootPath || '/workspace').replace(/\/$/, '')) || 'workspace',
      },
    },
    components,
  };
  if (outputPath) {
    await maybeWriteJsonArtifact({ conversationId, outputPath, payload: sbom });
    return { rootPath, path: outputPath, componentCount: components.length };
  }
  return { rootPath, componentCount: components.length, sbom };
}

async function cveLookup({ components = [], ecosystem = null, name = null, version = null }) {
  assertHostNetworkToolsEnabled('cve_lookup');
  const queries = [];
  if (Array.isArray(components) && components.length > 0) {
    for (const component of components.slice(0, 100)) {
      if (component?.name && component?.version) {
        queries.push({ package: { ecosystem: component.ecosystem || ecosystem || 'npm', name: component.name }, version: component.version });
      }
    }
  } else if (name && version) {
    queries.push({ package: { ecosystem: ecosystem || 'npm', name }, version });
  } else {
    throw createWorkspaceError('cve_lookup 需要 components 或 ecosystem+name+version', 'CVE_LOOKUP_INPUT_REQUIRED', 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_OSV_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw createWorkspaceError(`OSV 查询失败: HTTP ${response.status}`, 'CVE_LOOKUP_REMOTE_FAILED', 502);
    }
    const payload = await response.json();
    const results = Array.isArray(payload.results) ? payload.results : [];
    const findings = [];
    results.forEach((result, index) => {
      const vulns = Array.isArray(result?.vulns) ? result.vulns : [];
      if (vulns.length === 0) {
        return;
      }
      const query = queries[index];
      findings.push({
        package: query.package,
        version: query.version,
        vulnerabilities: vulns.map((vuln) => ({
          id: vuln.id,
          summary: vuln.summary || null,
          details: vuln.details ? slicePreview(vuln.details, 300) : null,
          aliases: vuln.aliases || [],
          severity: vuln.severity || [],
          references: vuln.references || [],
        })),
      });
    });
    return {
      queried: queries.length,
      findings,
      vulnerablePackages: findings.length,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createWorkspaceError('OSV 查询超时', 'CVE_LOOKUP_TIMEOUT', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ossLicenseScan({ conversationId, rootPath = '/workspace', maxFiles = DEFAULT_MAX_SEARCH_FILES }) {
  const walked = await walkWorkspaceFiles({ conversationId, rootPath, maxFiles, includeHidden: true });
  const findings = [];

  for (const file of walked.files) {
    const lowerName = file.name.toLowerCase();
    if (lowerName === 'package.json') {
      const parsed = await parsePackageJson({ conversationId, path: file.virtualPath });
      findings.push({
        path: parsed.path,
        type: 'manifest',
        license: parsed.license || 'UNKNOWN',
        packageName: parsed.packageName,
        ecosystem: 'npm',
      });
      continue;
    }
    if (lowerName === 'cargo.toml') {
      const parsed = await scanCargoToml({ conversationId, path: file.virtualPath });
      findings.push({
        path: parsed.path,
        type: 'manifest',
        license: parsed.license || 'UNKNOWN',
        packageName: parsed.packageName,
        ecosystem: 'cargo',
      });
      continue;
    }
    if (!/^licen[sc]e|copying|notice$/i.test(path.parse(lowerName).name)) {
      continue;
    }
    const { buffer } = await readFileBuffer(conversationId, file.virtualPath, DEFAULT_MAX_TEXT_BYTES);
    const text = bufferToUtf8(buffer);
    const detected = COMMON_LICENSE_PATTERNS.find((item) => item.pattern.test(text));
    findings.push({
      path: file.virtualPath,
      type: 'license-file',
      detectedLicense: detected?.id || 'UNKNOWN',
      excerpt: slicePreview(text, 200),
    });
  }

  return {
    rootPath,
    findings,
    truncated: walked.truncated,
  };
}

async function binaryAnalysis({ conversationId, path: targetPath }) {
  const { resolved, stat, buffer } = await readFileBuffer(conversationId, targetPath, 50 * 1024 * 1024);
  const printableStrings = extractPrintableStrings(buffer);
  return {
    path: resolved.virtualPath,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    md5: crypto.createHash('md5').update(buffer).digest('hex'),
    format: identifyBinaryFormat(buffer, resolved.virtualPath),
    entropy: computeEntropy(buffer),
    isLikelyBinary: isLikelyBinary(buffer),
    printableStrings,
    magicHex: buffer.subarray(0, Math.min(buffer.length, 16)).toString('hex'),
  };
}

async function dnsResolve({ hostname, recordType = 'A' }) {
  assertHostNetworkToolsEnabled('dns_resolve');
  const safe = await assertPublicRemoteHost(hostname);
  const type = String(recordType || 'A').toUpperCase();
  let records = [];
  if (type === 'A') {
    records = await dns.resolve4(safe.hostname);
  } else if (type === 'AAAA') {
    records = await dns.resolve6(safe.hostname);
  } else if (type === 'MX') {
    records = await dns.resolveMx(safe.hostname);
  } else if (type === 'TXT') {
    records = await dns.resolveTxt(safe.hostname);
  } else if (type === 'NS') {
    records = await dns.resolveNs(safe.hostname);
  } else if (type === 'CNAME') {
    records = await dns.resolveCname(safe.hostname);
  } else {
    throw createSandboxAccessError(`不支持的 DNS 记录类型: ${type}`, 'NETWORK_DNS_TYPE_UNSUPPORTED', 400);
  }
  return {
    hostname: safe.hostname,
    recordType: type,
    lookupAddresses: safe.addresses,
    records,
  };
}

async function portCheck({ host, port, timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS }) {
  assertHostNetworkToolsEnabled('port_check');
  const safe = await assertPublicRemoteHost(host);
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw createSandboxAccessError('端口必须是 1-65535 的整数', 'NETWORK_PORT_INVALID', 400, { port });
  }
  const startedAt = Date.now();
  const reachable = await new Promise((resolve) => {
    const socket = net.createConnection({ host: safe.hostname, port: numericPort });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ reachable: true }));
    socket.once('timeout', () => done({ reachable: false, reason: 'timeout' }));
    socket.once('error', (error) => done({ reachable: false, reason: error.code || error.message }));
  });
  return {
    host: safe.hostname,
    port: numericPort,
    latencyMs: Date.now() - startedAt,
    ...reachable,
  };
}

async function curlHeadOnly({ url, timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS }) {
  assertHostNetworkToolsEnabled('curl_head_only');
  const parsed = new URL(String(url || ''));
  await assertPublicRemoteHost(parsed.hostname);
  const response = await headRequest(parsed.toString(), timeoutMs);
  return {
    url: parsed.toString(),
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function httpHeadersInspect(args) {
  return await curlHeadOnly(args);
}

function validateAgainstSchema(schema = {}, value, pathName = '$', errors = []) {
  if (!schema || typeof schema !== 'object') {
    return errors;
  }
  const expectedType = schema.type;
  if (expectedType === 'object') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ path: pathName, code: 'INVALID_TYPE', expected: 'object', actual: Array.isArray(value) ? 'array' : typeof value });
      return errors;
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (value[key] === undefined) {
        errors.push({ path: `${pathName}.${key}`, code: 'MISSING_REQUIRED' });
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        validateAgainstSchema(childSchema, value[key], `${pathName}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push({ path: `${pathName}.${key}`, code: 'UNEXPECTED_PROPERTY' });
        }
      }
    }
    return errors;
  }
  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path: pathName, code: 'INVALID_TYPE', expected: 'array', actual: typeof value });
      return errors;
    }
    if (schema.items) {
      value.forEach((item, index) => validateAgainstSchema(schema.items, item, `${pathName}[${index}]`, errors));
    }
    return errors;
  }
  if (expectedType === 'string' && typeof value !== 'string') {
    errors.push({ path: pathName, code: 'INVALID_TYPE', expected: 'string', actual: typeof value });
  } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
    errors.push({ path: pathName, code: 'INVALID_TYPE', expected: 'boolean', actual: typeof value });
  } else if (expectedType === 'integer' && !Number.isInteger(value)) {
    errors.push({ path: pathName, code: 'INVALID_TYPE', expected: 'integer', actual: typeof value });
  } else if (expectedType === 'number' && (typeof value !== 'number' || Number.isNaN(value))) {
    errors.push({ path: pathName, code: 'INVALID_TYPE', expected: 'number', actual: typeof value });
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path: pathName, code: 'INVALID_ENUM', expected: schema.enum, actual: value });
  }
  return errors;
}

async function validateJsonSchemaTool({ conversationId, schemaPath = null, schemaText = null, dataPath = null, dataText = null }) {
  let schemaValue = schemaText;
  let dataValue = dataText;

  if (schemaPath) {
    const { buffer } = await readFileBuffer(conversationId, schemaPath, DEFAULT_MAX_TEXT_BYTES);
    schemaValue = bufferToUtf8(buffer);
  }
  if (dataPath) {
    const { buffer } = await readFileBuffer(conversationId, dataPath, DEFAULT_MAX_TEXT_BYTES);
    dataValue = bufferToUtf8(buffer);
  }
  if (typeof schemaValue !== 'string') {
    throw createWorkspaceError('必须提供 schemaPath 或 schemaText', 'JSON_SCHEMA_REQUIRED', 400);
  }
  if (typeof dataValue !== 'string') {
    throw createWorkspaceError('必须提供 dataPath 或 dataText', 'JSON_SCHEMA_DATA_REQUIRED', 400);
  }

  const schema = JSON.parse(schemaValue);
  const data = JSON.parse(dataValue);
  const errors = validateAgainstSchema(schema, data, '$', []);
  return {
    valid: errors.length === 0,
    errors,
  };
}

async function lintYaml({ conversationId, path: targetPath = null, text = null }) {
  let source = text;
  let sourcePath = null;
  if (targetPath) {
    const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
    source = bufferToUtf8(buffer);
    sourcePath = resolved.virtualPath;
  }
  if (typeof source !== 'string') {
    throw createWorkspaceError('必须提供 YAML 文本或文件路径', 'YAML_LINT_INPUT_REQUIRED', 400);
  }

  const warnings = [];
  const lines = source.replace(/\r/g, '').split('\n');
  lines.forEach((line, index) => {
    if (/\t/.test(line)) {
      warnings.push({ line: index + 1, code: 'TAB_INDENT', message: 'YAML 建议使用空格缩进，不要使用制表符' });
    }
    if (/\s+$/.test(line)) {
      warnings.push({ line: index + 1, code: 'TRAILING_SPACES', message: '行尾存在多余空格' });
    }
  });

  let parsed = null;
  let syntaxError = null;
  try {
    parsed = yaml.load(source);
  } catch (error) {
    syntaxError = {
      message: error.message,
      mark: error.mark || null,
    };
  }

  return {
    path: sourcePath,
    valid: !syntaxError,
    syntaxError,
    warnings,
    preview: parsed && typeof parsed === 'object' ? buildObjectAst(parsed, { maxNodes: 80 }) : null,
  };
}

async function checkOpenApiSpec({ conversationId, path: targetPath = null, text = null }) {
  let source = text;
  let sourcePath = null;
  if (targetPath) {
    const { resolved, buffer } = await readFileBuffer(conversationId, targetPath, DEFAULT_MAX_TEXT_BYTES);
    source = bufferToUtf8(buffer);
    sourcePath = resolved.virtualPath;
  }
  if (typeof source !== 'string') {
    throw createWorkspaceError('必须提供 OpenAPI 文本或文件路径', 'OPENAPI_INPUT_REQUIRED', 400);
  }

  let spec = null;
  try {
    spec = source.trim().startsWith('{') ? JSON.parse(source) : yaml.load(source);
  } catch (error) {
    return {
      path: sourcePath,
      valid: false,
      errors: [{ code: 'PARSE_ERROR', message: error.message }],
      warnings: [],
    };
  }

  const errors = [];
  const warnings = [];
  const version = spec?.openapi || spec?.swagger || null;
  if (!version) {
    errors.push({ code: 'VERSION_MISSING', message: '缺少 openapi 或 swagger 版本字段' });
  }
  if (!spec?.paths || typeof spec.paths !== 'object') {
    errors.push({ code: 'PATHS_MISSING', message: '缺少 paths 对象' });
  } else {
    for (const [route, operations] of Object.entries(spec.paths)) {
      if (!operations || typeof operations !== 'object') {
        errors.push({ code: 'PATH_ITEM_INVALID', message: `路径 ${route} 的定义不是对象` });
        continue;
      }
      for (const [method, operation] of Object.entries(operations)) {
        if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method)) {
          continue;
        }
        if (!operation?.responses || typeof operation.responses !== 'object') {
          errors.push({ code: 'RESPONSES_MISSING', message: `${method.toUpperCase()} ${route} 缺少 responses` });
        }
        if (!operation?.operationId) {
          warnings.push({ code: 'OPERATION_ID_MISSING', message: `${method.toUpperCase()} ${route} 未设置 operationId` });
        }
      }
    }
  }
  if (!spec?.info || typeof spec.info !== 'object') {
    errors.push({ code: 'INFO_MISSING', message: '缺少 info 对象' });
  }

  return {
    path: sourcePath,
    valid: errors.length === 0,
    version,
    errors,
    warnings,
  };
}

async function runUnitTests({ conversationId, cwd = '/workspace', command = null, args = [], timeoutMs = DEFAULT_TEST_TIMEOUT_MS }) {
  throw createWorkspaceError(
    'run_unit_tests 已禁用：禁止在宿主环境执行用户项目测试。',
    'RUN_TESTS_DISABLED',
    403,
    { conversationId, cwd, command, argsLength: Array.isArray(args) ? args.length : 0, timeoutMs },
  );
}

module.exports = {
  pdfParse,
  docxParse,
  markdownAst,
  codeAst,
  convertPdfToText,
  convertDocxToMd,
  jsonToYaml,
  yamlToJson,
  workspaceGrep,
  searchInFiles,
  fuzzySearch,
  detectDependencies,
  parsePackageJson,
  listPipRequirements,
  scanMavenPom,
  scanCargoToml,
  sbomGenerate,
  cveLookup,
  ossLicenseScan,
  binaryAnalysis,
  dnsResolve,
  portCheck,
  curlHeadOnly,
  httpHeadersInspect,
  validateJsonSchemaTool,
  checkOpenApiSpec,
  lintYaml,
  runUnitTests,
  parseRequirementsText,
  parsePackageJsonObject,
  parsePomXmlText,
  parseCargoTomlText,
  parsePyProjectTomlText,
  buildMarkdownAstFallback,
  scoreFuzzyMatch,
  validateAgainstSchema,
};
