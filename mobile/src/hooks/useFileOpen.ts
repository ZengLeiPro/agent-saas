import { useState, useCallback } from 'react';
import { Alert } from 'react-native';
import { fileCacheService } from '../services/fileCacheService';
import { openOrShareFile } from '../utils/openOrShareFile';

interface FileOpenOptions {
  path: string;
  modifiedAt: number;
  size: number;
  owner?: string;
  root?: boolean;
}

export function useFileOpen() {
  const [downloading, setDownloading] = useState(false);

  const open = useCallback(async (opts: FileOpenOptions) => {
    setDownloading(true);
    try {
      const uri = await fileCacheService.getOrDownload(
        opts.path,
        opts.modifiedAt,
        opts.size,
        opts.owner,
        opts.root,
      );
      await openOrShareFile(uri);
    } catch (err: any) {
      Alert.alert('下载失败', err?.message || String(err));
    } finally {
      setDownloading(false);
    }
  }, []);

  return { open, downloading };
}
