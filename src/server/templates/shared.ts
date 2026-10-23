// Template constants with no server dependencies, shared by the template
// service and the Admin form (which mirrors the service's validation).

/** Trigger statuses an EMAIL template may have; INTERVIEW and OFFER never send (E9). */
export const TRIGGER_STATUSES = ["APPLIED", "SCREENING", "HIRED", "REJECTED", "WITHDRAWN"] as const;
/** Custom field types of a requisition template (§7 `templates.schema_json`). */
export const FIELD_TYPES = ["TEXT", "NUMBER", "BOOLEAN", "PICKLIST"] as const;
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
export const MAX_FIELDS = 50;
