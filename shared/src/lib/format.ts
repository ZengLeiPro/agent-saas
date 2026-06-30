export const truncateContent = (content: string, maxLines = 2): { text: string; truncated: boolean } => {
  const lines = content.split("\n");
  if (lines.length <= maxLines) {
    return { text: content, truncated: false };
  }
  return { text: lines.slice(0, maxLines).join("\n") + "...", truncated: true };
};

export const formatJson = (str: string): string => {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
};

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
};
