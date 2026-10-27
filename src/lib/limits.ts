// Limits shared by the content script and the service worker. Plain constants only: no DOM, no
// extension or WXT imports, so both bundles can import this file.

/**
 * Controls per scan report and per fill plan (Plan 2 global constraints): the scanner keeps at most
 * this many, and the worker and the content script refuse a message with more.
 */
export const MAX_CONTROLS = 300;
