const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertObject(value, fieldPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }
}

function parseCronNumber(rawValue, { min, max, fieldName }) {
  const value = Number(rawValue);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid cron ${fieldName} value: ${rawValue}`);
  }
  if (value < min || value > max) {
    throw new Error(`Invalid cron ${fieldName} value: ${rawValue}`);
  }
  return fieldName === "day of week" && value === 7 ? 0 : value;
}

function addCronValue(values, value) {
  values.add(value === 7 ? 0 : value);
}

function parseCronToken(token, options) {
  const normalized = String(token ?? "").trim();
  if (!normalized) {
    throw new Error(`Invalid cron ${options.fieldName} field`);
  }

  const [base, rawStep] = normalized.split("/");
  if (normalized.split("/").length > 2) {
    throw new Error(`Invalid cron ${options.fieldName} field: ${normalized}`);
  }

  let step = 1;
  if (rawStep !== undefined) {
    step = Number(rawStep);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron ${options.fieldName} step: ${normalized}`);
    }
  }

  const values = new Set();
  if (base === "*") {
    for (let value = options.min; value <= options.max; value += step) {
      addCronValue(values, value);
    }
    return values;
  }

  const rangeParts = base.split("-");
  if (rangeParts.length === 2) {
    const start = parseCronNumber(rangeParts[0], options);
    const end = parseCronNumber(rangeParts[1], options);
    if (start > end) {
      throw new Error(`Invalid cron ${options.fieldName} range: ${normalized}`);
    }
    for (let value = start; value <= end; value += step) {
      addCronValue(values, value);
    }
    return values;
  }

  if (rangeParts.length > 2) {
    throw new Error(`Invalid cron ${options.fieldName} field: ${normalized}`);
  }

  const single = parseCronNumber(base, options);
  addCronValue(values, single);
  return values;
}

function parseCronField(field, options) {
  const normalized = String(field ?? "").trim();
  if (!normalized) {
    throw new Error(`Invalid cron ${options.fieldName} field`);
  }

  const values = new Set();
  for (const token of normalized.split(",")) {
    for (const value of parseCronToken(token, options)) {
      addCronValue(values, value);
    }
  }

  return {
    values,
    wildcard: normalized === "*"
  };
}

export function parseCronExpression(expression) {
  const normalized = String(expression ?? "")
    .trim()
    .replace(/\s+/g, " ");
  const fields = normalized.split(" ");
  if (fields.length !== 5) {
    throw new Error("cron must have exactly 5 fields");
  }

  return {
    minute: parseCronField(fields[0], { min: 0, max: 59, fieldName: "minute" }),
    hour: parseCronField(fields[1], { min: 0, max: 23, fieldName: "hour" }),
    dayOfMonth: parseCronField(fields[2], { min: 1, max: 31, fieldName: "day of month" }),
    month: parseCronField(fields[3], { min: 1, max: 12, fieldName: "month" }),
    dayOfWeek: parseCronField(fields[4], { min: 0, max: 7, fieldName: "day of week" })
  };
}

function matchesCronField(parsedField, value) {
  return parsedField.values.has(value);
}

export function cronMatchesDate(expression, date = new Date()) {
  const parsed = typeof expression === "string" ? parseCronExpression(expression) : expression;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  if (!matchesCronField(parsed.minute, minute) || !matchesCronField(parsed.hour, hour)) {
    return false;
  }
  if (!matchesCronField(parsed.month, month)) {
    return false;
  }

  const dayOfMonthMatches = matchesCronField(parsed.dayOfMonth, dayOfMonth);
  const dayOfWeekMatches = matchesCronField(parsed.dayOfWeek, dayOfWeek);

  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) {
    return true;
  }
  if (parsed.dayOfMonth.wildcard) {
    return dayOfWeekMatches;
  }
  if (parsed.dayOfWeek.wildcard) {
    return dayOfMonthMatches;
  }

  return dayOfMonthMatches || dayOfWeekMatches;
}

export function normalizeScheduleName(name, fieldPath = "schedule.name") {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`${fieldPath} must be a non-empty string`);
  }

  const normalized = name.trim();
  if (!SCHEDULE_NAME_PATTERN.test(normalized)) {
    throw new Error(`${fieldPath} must contain only letters, numbers, "_" or "-"`);
  }

  return normalized;
}

export function scheduleLookupKey(chatId, name) {
  return `${String(chatId)}:${normalizeScheduleName(name).toLowerCase()}`;
}

export function normalizeSchedule(rawSchedule, fieldPath) {
  assertObject(rawSchedule, fieldPath);

  const name = normalizeScheduleName(rawSchedule.name, `${fieldPath}.name`);
  if (typeof rawSchedule.cron !== "string" || !rawSchedule.cron.trim()) {
    throw new Error(`${fieldPath}.cron must be a non-empty string`);
  }
  const cron = rawSchedule.cron.trim().replace(/\s+/g, " ");
  parseCronExpression(cron);

  if (typeof rawSchedule.prompt !== "string" || !rawSchedule.prompt.trim()) {
    throw new Error(`${fieldPath}.prompt must be a non-empty string`);
  }

  const chatId = Number(rawSchedule.chatId);
  if (!Number.isSafeInteger(chatId)) {
    throw new Error(`${fieldPath}.chatId must be a safe integer`);
  }

  let enabled = true;
  if (Object.hasOwn(rawSchedule, "enabled")) {
    if (typeof rawSchedule.enabled !== "boolean") {
      throw new Error(`${fieldPath}.enabled must be a boolean`);
    }
    enabled = rawSchedule.enabled;
  }

  return {
    name,
    cron,
    prompt: rawSchedule.prompt.trim(),
    chatId,
    enabled
  };
}

export function normalizeBotSchedules(value, fieldPath) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an array`);
  }

  const schedules = value.map((schedule, index) =>
    normalizeSchedule(schedule, `${fieldPath}[${index}]`)
  );
  const seen = new Set();
  for (const schedule of schedules) {
    const key = scheduleLookupKey(schedule.chatId, schedule.name);
    if (seen.has(key)) {
      throw new Error(
        `Duplicate schedule name for chat ${schedule.chatId}: ${schedule.name}`
      );
    }
    seen.add(key);
  }

  return schedules;
}

export function formatScheduleMinuteKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}
