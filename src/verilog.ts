function stripComments(src: string): string {
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function detectTopModule(sources: Record<string, string>): string {
  // Priority 1: Look for top.sv or top.v
  const topFile = sources['top.sv'] || sources['top.v'];
  if (topFile) {
    const match = stripComments(topFile).match(/^\s*module\s+(\w+)/m);
    if (match) {
      return match[1];
    }
  }

  // Priority 2: Look for any file with "top" in the name
  for (const [fileName, src] of Object.entries(sources)) {
    if (fileName.toLowerCase().includes('top') && (fileName.endsWith('.v') || fileName.endsWith('.sv'))) {
      const match = stripComments(src).match(/^\s*module\s+(\w+)/m);
      if (match) {
        return match[1];
      }
    }
  }

  // Priority 3: Use the first module found
  const ordered = Object.entries(sources).sort(([a], [b]) => a.localeCompare(b));
  for (const [, src] of ordered) {
    const match = stripComments(src).match(/^\s*module\s+(\w+)/m);
    if (match) {
      return match[1];
    }
  }

  // Fallback
  return 'top';
}
