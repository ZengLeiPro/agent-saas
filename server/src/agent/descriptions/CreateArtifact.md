把一个工作区文件注册为持久 artifact，返回其 artifactId 和 fileCardMarker。
artifact 不会自动展示给用户。若需要把该文件交付给用户，必须在最终回答中原样包含返回的 fileCardMarker。
适用于需要事后下载、或要附加到后续步骤的文件、截图、补丁、日志。
敏感路径（如 .env、.git/、.ssh/、.npmrc）会被拒绝。
