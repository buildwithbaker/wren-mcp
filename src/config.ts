// config.ts
//
// Resolve the Wren notes directory for v1/dev:
//   1. env WREN_NOTES_DIR
//   2. --notes-dir <path> argv
// (Build Prompt 2's .mcpb manifest directory config will set WREN_NOTES_DIR.)
//
// If neither is set, resolution returns null and every tool reports a clear
// "notes folder not configured" error — the server still starts.

export interface ResolvedConfig {
  notesDir: string | null;
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2)
): ResolvedConfig {
  const fromEnv = env.WREN_NOTES_DIR?.trim();
  if (fromEnv) return { notesDir: fromEnv };

  const fromArgv = parseNotesDirArg(argv);
  if (fromArgv) return { notesDir: fromArgv };

  return { notesDir: null };
}

function parseNotesDirArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notes-dir') {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) return v.trim();
    } else if (a.startsWith('--notes-dir=')) {
      const v = a.slice('--notes-dir='.length).trim();
      if (v) return v;
    }
  }
  return null;
}

export const NOTES_DIR_NOT_CONFIGURED =
  'Wren notes folder is not configured. Set the WREN_NOTES_DIR environment ' +
  'variable (or pass --notes-dir <path>) to the directory that holds your ' +
  'Wren .md notes and .wren-index.json.';
