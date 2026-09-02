// Behavioral background dwell, not a retry timeout.
const deadline = Date.now() + 3000;
while (Date.now() < deadline) { /* bounded dwell */ }
