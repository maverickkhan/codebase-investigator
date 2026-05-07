import { Type, type FunctionDeclaration } from '@google/genai';

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'list_dir',
    description:
      'List files and directories in the repo. Returns a tree-like view, depth-limited. Use to explore unknown areas or confirm a path exists. Skips node_modules, .git, build dirs.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Repo-relative directory path. Empty/omit for root.' },
        depth: { type: Type.NUMBER, description: 'Tree depth (1-4). Default 2.' },
      },
    },
  },
  {
    name: 'read_file',
    description:
      'Read a text file with line numbers. Cap 400 lines per call; pass start/end to read further. ALWAYS use this to verify a claim before citing file:line. Refuses binary files and files > 2MB.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Repo-relative file path.' },
        start: { type: Type.NUMBER, description: '1-based start line. Default 1.' },
        end: { type: Type.NUMBER, description: '1-based end line, inclusive. Default start+399.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description:
      'Ripgrep across the repo. Returns up to 80 matches as `path:line: text`. Case-insensitive by default. Use this first to locate symbols, configs, or patterns before reading.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: { type: Type.STRING, description: 'Regex pattern. Escape special chars if literal.' },
        glob: { type: Type.STRING, description: 'Optional glob filter, e.g. "*.ts" or "src/**/*.py".' },
        case_sensitive: { type: Type.BOOLEAN, description: 'Default false.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_symbol',
    description:
      'Find definitions or call-sites of a named symbol. kind=def for definitions (function/class/const/etc), kind=use for call-sites, kind=any for raw matches. Faster than crafting a regex for common cases.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'Exact symbol name.' },
        kind: { type: Type.STRING, description: 'def | use | any. Default def.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'git_log',
    description:
      'Recent git commits, optionally filtered to a path. Useful for "why was this added" or to check churn. Up to 30 commits.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Optional repo-relative path filter.' },
        limit: { type: Type.NUMBER, description: 'Default 10, max 30.' },
      },
    },
  },
];
