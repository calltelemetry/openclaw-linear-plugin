const PREFIX = "[linear:diagnostic]";
export function emitDiagnostic(api, payload) {
    try {
        api.logger.info(`${PREFIX} ${JSON.stringify(payload)}`);
    }
    catch {
        // Never throw from telemetry
    }
}
