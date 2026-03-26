/* eslint-disable no-undef */

// Export/import defaults
// Export file header format:
//   CENSORCAT_EXPORT_V<extensionVersion>\n

const EXPORT_HEADER_PREFIX = "CENSORCAT_EXPORT_V";
const EXPORT_FILENAME_DEFAULT = "censorcat-export.txt";

// Encodes the UTF-8 string to base64 for export
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    bytes.forEach((b) => {
        binary += String.fromCharCode(b);
    });
    return btoa(binary);
}

// Decodes the base64 string to UTF-8 for import
function base64ToUtf8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

// Validates the regex pattern for import
function isValidRegexPattern(pattern, caseSensitive) {
    const flags = caseSensitive ? "g" : "gi";
    try {
        new RegExp(pattern, flags);
        return true;
    } catch {
        return false;
    }
}

// Validates the shape of the imported settings
function validateImportedSettingsShape(obj) {
    // There's probably a much better way to do this, but this'll work for now
    if (!obj || typeof obj !== "object") {
        return false;
    }
    if (typeof obj.disableCensor !== "boolean") {
        return false;
    }
    if (!Number.isInteger(obj.censorMode) || obj.censorMode < 0 || obj.censorMode > 3) {
        return false;
    }
    if (typeof obj.censorChar !== "string" || obj.censorChar.length === 0) {
        return false;
    }
    if (typeof obj.censorSub !== "string") {
        return false;
    }
    if (!Array.isArray(obj.censoredPhrases)) {
        return false;
    }
    for (let i = 0; i < obj.censoredPhrases.length; i += 1) {
        const e = obj.censoredPhrases[i];
        if (!Array.isArray(e) || e.length < 3) {
            return false;
        }
        const [phrase, caseSens, isRx] = e;
        if (typeof phrase !== "string" || typeof caseSens !== "boolean" || typeof isRx !== "boolean") {
            return false;
        }
        if (isRx && !isValidRegexPattern(phrase, caseSens)) {
            return false;
        }
    }
    if (!Array.isArray(obj.ignoredSites)) {
        return false;
    }
    for (let i = 0; i < obj.ignoredSites.length; i += 1) {
        const e = obj.ignoredSites[i];
        if (!Array.isArray(e) || e.length < 2) {
            return false;
        }
        if (typeof e[0] !== "string" || typeof e[1] !== "boolean") {
            return false;
        }
    }
    return true;
}

// Decodes the import file text & imports the settings
function decodeImportFile(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "").trim();
    if (!raw) {
        return { ok: false, exportVersion: null };
    }

    const lines = raw.split(/\r?\n/);
    const headerLine = String(lines[0] || "").trim();
    if (!headerLine.startsWith(EXPORT_HEADER_PREFIX)) {
        return { ok: false, exportVersion: null };
    }

    const exportVersionRaw = headerLine.slice(EXPORT_HEADER_PREFIX.length).trim();
    const exportVersion = exportVersionRaw.length > 0 ? exportVersionRaw : null;

    const base64Part = lines.slice(1).join("\n").trim();
    if (!base64Part) {
        return { ok: false, exportVersion };
    }

    let jsonStr;
    try {
        jsonStr = base64ToUtf8(base64Part);
    } catch {
        return { ok: false, exportVersion };
    }
    let obj;
    try {
        obj = JSON.parse(jsonStr);
    } catch {
        return { ok: false, exportVersion };
    }
    if (!obj || typeof obj !== "object" || obj.v !== 1) {
        return { ok: false, exportVersion };
    }
    const rest = { ...obj };
    delete rest.v;
    if (!validateImportedSettingsShape(rest)) {
        return { ok: false, exportVersion };
    }
    return { ok: true, settings: normalizeSettings(rest), exportVersion };
}

// Builds the export file body
function buildExportFileBody(settings) {
    const normalized = normalizeSettings(settings);
    const envelope = { v: 1, ...normalized };

    let currentVersion = "unknown";
    try {
        const manifest = browser.runtime && browser.runtime.getManifest ? browser.runtime.getManifest() : null;
        if (manifest && typeof manifest.version === "string" && manifest.version.length > 0) {
            currentVersion = manifest.version;
        }
    } catch {
        // leave unknown
    }

    const header = `${EXPORT_HEADER_PREFIX}${currentVersion}`;
    return `${header}\n${utf8ToBase64(JSON.stringify(envelope))}`;
}

function scheduleRevokeBlobUrl(downloadId, blobUrl) {
    const doneStates = new Set(["complete", "interrupted"]);

    const onChanged = (delta) => {
        if (delta.id !== downloadId || !delta.state || !doneStates.has(delta.state.current)) {
            return;
        }
        try {
            URL.revokeObjectURL(blobUrl);
        } catch {
            // ignore
        }
        browser.downloads.onChanged.removeListener(onChanged);
    };

    browser.downloads.onChanged.addListener(onChanged);

    window.setTimeout(() => {
        try {
            URL.revokeObjectURL(blobUrl);
        } catch {
            // ignore
        }
        browser.downloads.onChanged.removeListener(onChanged);
    }, 300_000);
}

// Downloads the export file to the user's device
async function downloadExportFile(body, filename) {
    if (typeof body !== "string") {
        throw new Error("Invalid export payload.");
    }
    const name = typeof filename === "string" && filename.length > 0
        ? filename
        : "censorcat-settings.txt";

    // Create the blob URL for the export file & attempt to download it
    let blobUrl = null;
    try {
        const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
        blobUrl = URL.createObjectURL(blob);
        const downloadId = await browser.downloads.download({
            url: blobUrl,
            filename: name,
            saveAs: true
        });
        scheduleRevokeBlobUrl(downloadId, blobUrl);
        blobUrl = null;
    } catch (err) {
        if (blobUrl) {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch {
                // ignore
            }
        }
        throw err;
    }
}

// Sets the status of the export/import process
function setIoStatus(el, text, isError) {
    if (!el) {
        return;
    }
    el.textContent = text;
    el.classList.toggle("is-error", Boolean(isError));
}

// Initializes the export/import page
function initExportImportPage() {
    // Get the export/import buttons and status elements
    const exportBtn = document.getElementById("export-settings");
    const exportStatus = document.getElementById("export-status");
    const input = document.getElementById("import-file");
    const importBtn = document.getElementById("import-choose");
    const importStatus = document.getElementById("import-status");

    // If any of the elements are not found, return
    if (!exportBtn || !exportStatus || !input || !importBtn || !importStatus) {
        return;
    }

    // If any of the functions are not found, set the status to an error
    if (
        typeof buildExportFileBody !== "function"
        || typeof decodeImportFile !== "function"
        || typeof loadSettings !== "function"
        || typeof saveSettings !== "function"
    ) {
        setIoStatus(exportStatus, "We're sorry, but the scripts failed to load. Please reload this tab to try again. If you see this error again, please get in contact with us!", true);
        return;
    }

    // Listener for export button
    exportBtn.addEventListener("click", () => {
        void (async () => {
            setIoStatus(exportStatus, "");
            try {
                const settings = await loadSettings();
                const body = buildExportFileBody(settings);
                await downloadExportFile(body, EXPORT_FILENAME_DEFAULT);
                setIoStatus(exportStatus, "Download started.", false);
            } catch (err) {
                const msg = err && typeof err.message === "string" ? err.message : String(err);
                setIoStatus(exportStatus, `Export failed.${msg ? ` ${msg}` : ""}`, true);
            }
        })();
    });

    // Listener for import button
    importBtn.addEventListener("click", () => {
        setIoStatus(importStatus, "");
        input.value = "";
        input.click();
    });

    // Listener for file input change
    input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            void (async () => {
                try {
                    const text = typeof reader.result === "string" ? reader.result : "";
                    const parsed = decodeImportFile(text);
                    if (!parsed.ok) {
                        let currentVersion = "unknown";
                        try {
                            const manifest = browser.runtime && browser.runtime.getManifest ? browser.runtime.getManifest() : null;
                            if (manifest && typeof manifest.version === "string" && manifest.version.length > 0) {
                                currentVersion = manifest.version;
                            }
                        } catch {
                            // leave unknown
                        }

                        const fileVersion = parsed.exportVersion;
                        const isVersionMismatch = Boolean(fileVersion) && fileVersion !== currentVersion;

                        if (isVersionMismatch) {
                            setIoStatus(
                                importStatus,
                                "The file you chose to import is from a different version of CensorCAT that cannot be imported into this new version.\n\n" +
                                    `Your current version: ${currentVersion}\n` +
                                    `Version of file export: ${fileVersion}`,
                                true
                            );
                        } else {
                            setIoStatus(
                                importStatus,
                                "This file could not be imported because it does not match the expected template.",
                                true
                            );
                        }
                        return;
                    }
                    await saveSettings(parsed.settings);
                    setIoStatus(
                        importStatus,
                        "Settings imported successfully. You can safely close this tab.",
                        false
                    );
                } catch (err) {
                    const msg = err && typeof err.message === "string" ? err.message : String(err);
                    setIoStatus(importStatus, `Import failed: ${msg}`, true);
                }
            })();
        };
        reader.onerror = () => {
            setIoStatus(importStatus, "Could not read the selected file.", true);
        };
        reader.readAsText(file, "UTF-8");
    });
}

initExportImportPage();
