// Behavioral background dwell for the 30-second lifecycle boundary.
const deadline = Date.now() + 30000;
while (Date.now() < deadline) { /* bounded dwell */ }
