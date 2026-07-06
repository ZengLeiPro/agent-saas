Register a workspace file as a durable artifact and return its artifactId plus a fileCardMarker.
The artifact is not automatically shown to the user. If the file should be delivered to the user, include the returned fileCardMarker exactly in your final answer.
Use this for files, screenshots, patches, or logs that should be downloaded later or attached to follow-up steps.
Sensitive paths such as .env, .git/, .ssh/, and .npmrc are rejected.
