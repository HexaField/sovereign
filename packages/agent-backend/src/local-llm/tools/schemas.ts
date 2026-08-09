// JSON Schemas for the local-llm backend's built-in tool set, in OpenAI
// function-calling format. `ToolSchema` is the shape @sovereign/summary's
// inference client already sends over the wire (`{ type: 'function',
// function: { name, description, parameters } }`) — reused here so both
// consumers of the OpenAI-compatible chat-completions endpoint agree on one
// definition instead of drifting apart.
//
// Field names deliberately mirror Claude Code's own Read/Write/Edit/Bash/
// Grep/Glob/LS tools (including Grep's `-i`/`-n`/`-A`/`-B`/`-C` flags) —
// local models fine-tuned on Claude Code tool-call traces already know this
// shape, which measurably improves tool-call reliability over a bespoke one.

import type { ToolSchema } from '../inference.js'

export type { ToolSchema }

const readSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'Read',
    description:
      'Reads a file from the local filesystem. Returns the content prefixed with line numbers (like `cat -n`). ' +
      'Lines longer than 2000 characters are truncated. Use offset/limit to page through large files.',
    parameters: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read.' },
        offset: { type: 'integer', minimum: 0, description: 'Line number to start reading from (0-indexed).' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to read. Defaults to 2000.' }
      },
      additionalProperties: false
    }
  }
}

const writeSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'Write',
    description:
      'Writes content to a file, creating parent directories as needed. Overwrites the file if it already exists. ' +
      'Refuses to overwrite a file that has not been Read in this session — Read it first.',
    parameters: {
      type: 'object',
      required: ['file_path', 'content'],
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write.' },
        content: { type: 'string', description: 'Full content to write to the file.' }
      },
      additionalProperties: false
    }
  }
}

const editSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'Edit',
    description:
      'Replaces an exact string match in a file with a new string. `old_string` must appear exactly once in the ' +
      'file unless `replace_all` is true — include enough surrounding context to make it unique. The file must ' +
      'have been Read in this session before it can be edited.',
    parameters: {
      type: 'object',
      required: ['file_path', 'old_string', 'new_string'],
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit.' },
        old_string: {
          type: 'string',
          description: 'Exact text to find. Must be unique in the file unless replace_all is set.'
        },
        new_string: { type: 'string', description: 'Text to replace old_string with. Must differ from old_string.' },
        replace_all: {
          type: 'boolean',
          description:
            'Replace every occurrence of old_string instead of requiring exactly one match. Defaults to false.'
        }
      },
      additionalProperties: false
    }
  }
}

const bashSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'Bash',
    description:
      'Executes a shell command and returns its stdout and stderr. Commands run under a timeout and are ' +
      'restricted to the configured sandbox directories.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        cwd: {
          type: 'string',
          description: 'Working directory for the command. Defaults to the session working directory.'
        },
        timeout: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum time to allow the command to run, in milliseconds.'
        }
      },
      additionalProperties: false
    }
  }
}

const grepSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'Grep',
    description:
      'Searches file contents using ripgrep. Supports regular expressions plus path/glob/type filters, and three ' +
      'output modes: "files_with_matches" (default), "content", or "count".',
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern to search for.' },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to the session working directory.'
        },
        glob: { type: 'string', description: 'Glob filter for files to include, e.g. "*.ts".' },
        type: { type: 'string', description: 'Restrict the search to a ripgrep file type, e.g. "js", "py", "rust".' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'What to return. Defaults to "files_with_matches".'
        },
        '-i': { type: 'boolean', description: 'Case-insensitive search.' },
        '-n': { type: 'boolean', description: 'Show line numbers in output (content mode only). Defaults to true.' },
        '-A': {
          type: 'integer',
          minimum: 0,
          description: 'Lines of context to show after each match (content mode only).'
        },
        '-B': {
          type: 'integer',
          minimum: 0,
          description: 'Lines of context to show before each match (content mode only).'
        },
        '-C': {
          type: 'integer',
          minimum: 0,
          description: 'Lines of context to show before and after each match (content mode only).'
        },
        multiline: { type: 'boolean', description: 'Allow patterns to span multiple lines. Defaults to false.' },
        head_limit: { type: 'integer', minimum: 1, description: 'Cap the number of results returned. Defaults to 250.' }
      },
      additionalProperties: false
    }
  }
}

const globSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'Glob',
    description:
      'Finds files matching a glob pattern (e.g. "**/*.ts", "src/**/*.test.js"). Results are sorted by ' +
      'modification time, most recently modified first.',
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match against file paths relative to `path`.' },
        path: { type: 'string', description: 'Directory to search within. Defaults to the session working directory.' }
      },
      additionalProperties: false
    }
  }
}

const lsSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'LS',
    description: 'Lists the contents of a directory, showing entry type, size, and modification time for each item.',
    parameters: {
      type: 'object',
      required: [],
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to list. Defaults to the session working directory.'
        },
        ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to exclude from the listing.' }
      },
      additionalProperties: false
    }
  }
}

/** All 7 built-in tool schemas, sent verbatim as `tools` on every chat-completion request. */
export const TOOL_SCHEMAS: ToolSchema[] = [
  readSchema,
  writeSchema,
  editSchema,
  bashSchema,
  grepSchema,
  globSchema,
  lsSchema
]
