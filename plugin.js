// Blueprint 0.1.0-preview.2 — self-contained Buzz API v1 plugin
// model.mjs
export const BLUEPRINT_TYPE = "opcb.blueprint.board";
export const BLUEPRINT_CONTENT_BYTES = 128 * 1024;
export const BLUEPRINT_EVENT_BYTES = 512 * 1024 - 16;
export const BLUEPRINT_STATUS = {
  todo: "未开始",
  doing: "进行中",
  done: "已完成",
  risk: "风险",
};
export const byteLength = (text) => new TextEncoder().encode(text).length;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const own = (object, key) => Object.hasOwn(object, key);
function textField(value, fallback, max, name) {
  const text = value === undefined ? fallback : value;
  if (typeof text !== "string" || text.length > max || text.includes("\0"))
    throw new Error(`${name}格式不正确或过长。`);
  return text;
}
function numberField(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isFinite(number) || number < min || number > max)
    throw new Error(`${name}超出范围。`);
  return number;
}
export function normalizeBoard(input) {
  const value = input?.board ?? input;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 500
  )
    throw new Error(
      "请选择一页蓝图导出的 JSON（schemaVersion: 1，最多 500 张便签）。",
    );
  const board = {
    schemaVersion: 1,
    title: textField(value.title, "OPCB Blueprint", 200, "蓝图标题"),
    nodes: [],
  };
  if (!board.title.trim() || byteLength(board.title) > 512)
    throw new Error("蓝图标题不能为空，且须小于 512 字节。");
  const ids = new Set();
  for (const node of value.nodes) {
    if (
      !node ||
      typeof node !== "object" ||
      typeof node.id !== "string" ||
      !identifier.test(node.id) ||
      ids.has(node.id) ||
      !["project", "note"].includes(node.type)
    )
      throw new Error("便签 ID、类型或重复数据不正确。");
    ids.add(node.id);
    for (const key of ["parentId", "linkedProjectId"])
      if (
        node[key] != null &&
        (typeof node[key] !== "string" || !identifier.test(node[key]))
      )
        throw new Error("便签关联不正确。");
    if (node.status !== undefined && !own(BLUEPRINT_STATUS, node.status))
      throw new Error("便签状态不正确。");
    if (node.collapsed !== undefined && typeof node.collapsed !== "boolean")
      throw new Error("折叠状态不正确。");
    board.nodes.push({
      id: node.id,
      type: node.type,
      parentId: node.parentId ?? null,
      title: textField(node.title, "未命名便签", 200, "便签标题"),
      body: textField(node.body, "", 20000, "便签内容"),
      x: numberField(node.x, 0, -100000, 100000, "横坐标"),
      y: numberField(node.y, 0, -100000, 100000, "纵坐标"),
      rotation: numberField(node.rotation, 0, -360, 360, "旋转角度"),
      status: node.status ?? "todo",
      owner: textField(node.owner, "", 100, "负责人"),
      progress: numberField(
        node.progress,
        node.status === "done" ? 100 : 0,
        0,
        100,
        "进度",
      ),
      collapsed: node.collapsed ?? false,
      linkedProjectId: node.linkedProjectId ?? null,
      updatedAt: textField(node.updatedAt, "", 40, "更新时间"),
    });
  }
  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  for (const node of board.nodes) {
    if (node.type === "note" && node.parentId)
      throw new Error("说明便签应关联项目，不能作为项目下级。");
    if (node.type === "project" && node.linkedProjectId)
      throw new Error("只有说明便签可关联项目。");
    if (
      node.linkedProjectId &&
      byId.get(node.linkedProjectId)?.type !== "project"
    )
      throw new Error("说明便签关联的项目不存在。");
    const seen = new Set([node.id]);
    let cursor = node;
    let depth = 1;
    while (cursor.parentId) {
      const parent = byId.get(cursor.parentId);
      if (parent?.type !== "project" || seen.has(parent.id) || ++depth > 3)
        throw new Error("项目层级必须完整、无循环且最多三级。");
      seen.add(parent.id);
      cursor = parent;
    }
  }
  if (byteLength(JSON.stringify(board)) > BLUEPRINT_CONTENT_BYTES)
    throw new Error(
      "蓝图超过 128 KiB，请拆成多张蓝图后导入；当前内容没有被覆盖。",
    );
  return board;
}
export function blankBoard(title = "OPCB Blueprint") {
  return { schemaVersion: 1, title, nodes: [] };
}
export function nodeDepth(board, node) {
  let depth = 1,
    parent = node.parentId;
  while (parent) {
    depth++;
    parent = board.nodes.find((item) => item.id === parent)?.parentId;
  }
  return depth;
}
export function descendantIds(board, id) {
  const result = new Set([id]);
  for (let level = 0; level < 3; level++)
    for (const node of board.nodes)
      if (result.has(node.parentId)) result.add(node.id);
  return result;
}
export function changeBoard(board, operation) {
  const next = normalizeBoard(board);
  if (operation.type === "rename") next.title = operation.title;
  else if (operation.type === "create") {
    if (next.nodes.some((node) => node.id === operation.node.id))
      throw new Error("该便签已经存在。");
    next.nodes.push(operation.node);
  } else if (operation.type === "update") {
    const node = next.nodes.find((item) => item.id === operation.id);
    if (!node) throw new Error("便签已被删除，请刷新。");
    const allowed = new Set([
      "title",
      "body",
      "x",
      "y",
      "rotation",
      "status",
      "owner",
      "progress",
      "collapsed",
      "parentId",
      "linkedProjectId",
    ]);
    for (const key of Object.keys(operation.patch))
      if (!allowed.has(key)) throw new Error("不支持的便签修改。");
    Object.assign(node, operation.patch, {
      updatedAt: new Date().toISOString(),
    });
  } else if (operation.type === "delete") {
    if (!next.nodes.some((node) => node.id === operation.id))
      throw new Error("便签不存在。");
    const removed = descendantIds(next, operation.id);
    next.nodes = next.nodes.filter((node) => !removed.has(node.id));
    for (const node of next.nodes)
      if (removed.has(node.linkedProjectId)) node.linkedProjectId = null;
  } else throw new Error("不支持的蓝图操作。");
  return normalizeBoard(next);
}
export function visibleBoardNodes(board, focusId) {
  if (focusId)
    return board.nodes.filter(
      (node) =>
        node.id === focusId ||
        node.parentId === focusId ||
        node.linkedProjectId === focusId ||
        board.nodes.find((item) => item.id === focusId)?.linkedProjectId ===
          node.id,
    );
  return board.nodes.filter((node) => {
    let parent = node.parentId;
    while (parent) {
      const value = board.nodes.find((item) => item.id === parent);
      if (value?.collapsed) return false;
      parent = value?.parentId;
    }
    return true;
  });
}

// storage.mjs

const hashPattern = /^[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function normalizeAccess(access) {
  if (
    !access ||
    Object.keys(access).some((key) => !["admin", "editors"].includes(key)) ||
    !hashPattern.test(access.admin) ||
    !Array.isArray(access.editors) ||
    access.editors.length > 100 ||
    access.editors.some(
      (key) => typeof key !== "string" || !hashPattern.test(key),
    )
  )
    throw new Error("蓝图协作授权格式不正确。");
  return {
    admin: access.admin,
    editors: [...new Set(access.editors)]
      .filter((key) => key !== access.admin)
      .sort(),
  };
}
export function blueprintAccess(record, viewer) {
  const canManage = !!viewer && record?.access?.admin === viewer;
  return {
    canManage,
    canEdit:
      canManage ||
      (!!viewer && record?.access?.editors.includes(viewer) === true),
  };
}
export function artifactTag(event, key) {
  const matches = event.tags?.filter((tag) => tag[0] === key) ?? [];
  return matches.length === 1 && matches[0].length === 2
    ? matches[0][1]
    : undefined;
}
export function decodeBlueprint(event, channel, id) {
  if (
    event?.kind !== 45010 ||
    !hashPattern.test(event.id) ||
    artifactTag(event, "ar") !== "1" ||
    artifactTag(event, "h") !== channel ||
    artifactTag(event, "type") !== BLUEPRINT_TYPE ||
    !uuidPattern.test(artifactTag(event, "d")) ||
    (id && artifactTag(event, "d") !== id) ||
    !["create", "update", "restore"].includes(artifactTag(event, "op"))
  )
    throw new Error("社区返回的蓝图记录不完整或类型不符，已停止读取。");
  if (
    typeof event.content !== "string" ||
    byteLength(event.content) > BLUEPRINT_CONTENT_BYTES
  )
    throw new Error("社区中的蓝图超过当前版本支持范围。");
  const allowed = new Set(["ar", "d", "h", "type", "title", "op", "prev"]);
  if (
    event.tags.some((tag) => !allowed.has(tag[0]) || tag.length !== 2) ||
    !artifactTag(event, "title") ||
    (artifactTag(event, "op") !== "create" &&
      !hashPattern.test(artifactTag(event, "prev")))
  )
    throw new Error("这张蓝图使用了当前插件不支持的记录格式，请先升级插件。");
  if (
    artifactTag(event, "op") === "create" &&
    event.tags.some((tag) => tag[0] === "prev")
  )
    throw new Error("新建蓝图不能引用已有版本。");
  const stored = JSON.parse(event.content);
  const wrapped = stored?.schemaVersion === 2;
  if (
    wrapped &&
    Object.keys(stored).some(
      (key) => !["schemaVersion", "board", "access"].includes(key),
    )
  )
    throw new Error(
      "社区蓝图包含当前版本不支持的字段，已停止编辑以保留原数据。",
    );
  const access = wrapped ? normalizeAccess(stored.access) : null;
  const payload = wrapped ? stored.board : stored;
  const nodeKeys = new Set([
    "id",
    "type",
    "parentId",
    "title",
    "body",
    "x",
    "y",
    "rotation",
    "status",
    "owner",
    "progress",
    "collapsed",
    "linkedProjectId",
    "updatedAt",
  ]);
  if (
    !payload ||
    typeof payload !== "object" ||
    Object.keys(payload).some(
      (key) => !["schemaVersion", "title", "nodes"].includes(key),
    ) ||
    !Array.isArray(payload.nodes) ||
    payload.nodes.some(
      (node) =>
        !node ||
        typeof node !== "object" ||
        Object.keys(node).some((key) => !nodeKeys.has(key)),
    )
  )
    throw new Error(
      "社区蓝图包含当前版本不支持的字段，已停止编辑以保留原数据。",
    );
  const board = normalizeBoard(payload);
  return {
    id: artifactTag(event, "d"),
    revision: event.id,
    board,
    access,
    event,
  };
}
export function writableChannel(session, channel) {
  const value = session.channels.get(channel);
  return (
    !!value &&
    !value.readOnly &&
    !value.cached &&
    !value.pending &&
    !value.archived &&
    !!session.viewer &&
    value.members?.includes(session.viewer) === true
  );
}
export function createBlueprintStore(session, active = () => true) {
  const pending = new Map();
  function check(signal) {
    signal?.throwIfAborted();
    if (!active())
      throw new Error("社区或账号已经切换，请重新打开 Blueprint。");
  }
  async function read(filters, signal) {
    check(signal);
    if (!session.snapshotRead)
      throw new Error("当前客户端没有蓝图读取接口，请更新 Buzz。");
    const events = await session.snapshotRead(filters, { signal });
    check(signal);
    return events;
  }
  async function head(channel, id, signal) {
    const events = await read(
      [
        {
          kinds: [45010],
          "#h": [channel],
          "#d": [id],
          artifact: "current",
          limit: 2,
        },
      ],
      signal,
    );
    if (events.length > 1)
      throw new Error("蓝图出现多个当前版本，已停止写入。");
    return events.length ? decodeBlueprint(events[0], channel, id) : null;
  }
  async function list(channel, signal) {
    const result = [],
      seen = new Set();
    // An exact full page needs another request; never call a capped page complete.
    for (let offset = 0; offset <= 1000; offset += 100) {
      const events = await read(
        [
          {
            kinds: [45010],
            "#h": [channel],
            "#type": [BLUEPRINT_TYPE],
            artifact: "current",
            limit: 100,
            offset,
          },
        ],
        signal,
      );
      for (const event of events) {
        const item = decodeBlueprint(event, channel);
        if (seen.has(item.id))
          throw new Error("读取期间蓝图列表发生变化，请重新刷新。");
        seen.add(item.id);
        result.push(item);
      }
      if (events.length < 100) return result;
    }
    throw new Error("蓝图列表超过本次读取范围，请拆分到其他频道。");
  }
  async function authority(channel, signal) {
    check(signal);
    if (
      !session.channels.refreshRoster ||
      (await session.channels.refreshRoster(channel, {
        consistency: "strong",
        signal,
      })) !== true
    )
      throw new Error("无法确认当前频道权限，请联网后重试。");
    check(signal);
    if (!writableChannel(session, channel))
      throw new Error("当前频道不可写；请确认成员资格、频道状态和网络连接。");
    if (!session.memberAdministration?.refresh)
      throw new Error("当前客户端不能确认写入角色。");
    await session.memberAdministration.refresh(channel);
    check(signal);
    const state = session.memberAdministration.snapshot(channel);
    const role = state.authority?.roles?.[session.viewer];
    if (
      state.status !== "ready" ||
      !["owner", "admin", "member", "bot"].includes(role)
    )
      throw new Error("当前角色仅可查看蓝图，写入权限未确认。");
    if (!session.configArtifactWriter)
      throw new Error("当前客户端没有蓝图保存接口。");
  }
  async function save(channel, original, value, signal, requestedEditors) {
    check(signal);
    const board = normalizeBoard(value);
    if (
      !uuidPattern.test(channel) ||
      !uuidPattern.test(original.id) ||
      original.id === "00000000-0000-0000-0000-000000000000" ||
      (original.revision !== null && !hashPattern.test(original.revision))
    )
      throw new Error("蓝图版本或频道不正确。");
    await authority(channel, signal);
    const before = await head(channel, original.id, signal);
    const key = `${channel}:${original.id}`,
      previous = pending.get(key);
    if (previous && before?.revision === previous.signed.id) {
      pending.delete(key);
      return before;
    }
    let access = before?.access ?? { admin: session.viewer, editors: [] };
    if (before && !before.access)
      throw new Error(
        "这张旧版蓝图尚未设置协作授权，请导出后重新导入为新蓝图。",
      );
    if (before && !blueprintAccess(before, session.viewer).canEdit)
      throw new Error("你当前仅可查看这张蓝图，请联系蓝图管理员授权编辑。");
    if (requestedEditors !== undefined) {
      if (!before || !blueprintAccess(before, session.viewer).canManage)
        throw new Error("只有蓝图管理员可以修改编辑者名单。");
      access = normalizeAccess({
        admin: before.access.admin,
        editors: requestedEditors,
      });
      if (
        access.editors.some(
          (member) => !session.channels.get(channel)?.members?.includes(member),
        )
      )
        throw new Error("只能授权当前频道成员，请刷新名单后重试。");
    }
    const content = JSON.stringify({ schemaVersion: 2, board, access });
    if (byteLength(content) > BLUEPRINT_CONTENT_BYTES)
      throw new Error("蓝图与协作授权合计超过 128 KiB。");
    if (
      previous &&
      (previous.content !== content || previous.base !== original.revision)
    )
      throw new Error(
        "上一次保存结果尚未确认。请先刷新核对或导出草稿，不能签发另一份修改。",
      );
    if (
      (original.revision === null && before) ||
      (original.revision !== null && before?.revision !== original.revision)
    )
      throw new Error(
        "其他成员已修改或删除这张蓝图。你的草稿已保留；请导出草稿，再刷新并合并，不能直接覆盖。",
      );
    const template = {
      kind: 45010,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags: [
        ["ar", "1"],
        ["d", original.id],
        ["h", channel],
        ["type", BLUEPRINT_TYPE],
        ["title", board.title],
        ["op", original.revision === null ? "create" : "update"],
        ...(original.revision ? [["prev", original.revision]] : []),
      ],
    };
    const signed =
      previous?.signed ??
      (await session.configArtifactWriter.sign(template, signal));
    check(signal);
    // Do not publish a host response that changed our requested target or payload.
    if (
      signed.content !== content ||
      signed.kind !== template.kind ||
      (!previous && signed.created_at !== template.created_at) ||
      signed.pubkey !== session.viewer ||
      JSON.stringify(signed.tags) !== JSON.stringify(template.tags) ||
      !hashPattern.test(signed.id) ||
      byteLength(JSON.stringify(signed)) > BLUEPRINT_EVENT_BYTES
    )
      throw new Error("签名记录与蓝图内容不匹配或超过大小限制，未发送。");
    let publicationError;
    pending.set(key, { signed, content, base: original.revision });
    try {
      await session.configArtifactWriter.publish(signed, signal);
    } catch (error) {
      publicationError = error;
    }
    check(signal);
    let after;
    try {
      after = await head(channel, original.id, signal);
    } catch (error) {
      throw new Error(
        `保存结果尚无法确认，草稿已保留。请先刷新核对，勿重复创建。${error.message}`,
      );
    }
    if (after?.revision === signed.id) {
      pending.delete(key);
      return after;
    }
    if (after && after.revision !== original.revision) {
      pending.delete(key);
      throw new Error("共享蓝图版本已变化，草稿已保留，请刷新后核对。");
    }
    if (
      /^(conflict|restricted|auth-required|blocked|invalid|rate-limited):/.test(
        publicationError?.message ?? "",
      )
    )
      pending.delete(key);
    throw new Error(
      publicationError
        ? `社区未确认保存：${publicationError.message || publicationError}。草稿已保留。`
        : "社区尚未回读到保存结果，草稿已保留，请先刷新核对。",
    );
  }
  const setEditors = (channel, original, editors, signal) =>
    save(channel, original, original.board, signal, editors);
  return { list, head, save, authority, setEditors };
}

// focus-layout.mjs
// Focus is a local projection. Shared coordinates and collapse state stay intact.
export function focusNodes(nodes, rootId) {
  const root = nodes.find((node) => node.id === rootId);
  if (!root) return [];
  const related = nodes.filter(
    (node) =>
      node.id !== rootId &&
      (node.parentId === rootId ||
        node.linkedProjectId === rootId ||
        (root.type === "note" && node.id === root.linkedProjectId)),
  );
  return [
    root,
    ...related.filter((node) => node.type !== "note"),
    ...related.filter((node) => node.type === "note"),
  ];
}

export function focusTrail(nodes, rootId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const trail = [],
    seen = new Set();
  let current = byId.get(rootId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    current = byId.get(current.parentId || current.linkedProjectId);
  }
  return trail;
}

export function focusLayout(nodes, rootId, sizeOf, width) {
  const members = focusNodes(nodes, rootId),
    positions = new Map();
  if (!members.length) return positions;
  positions.set(rootId, { x: 0, y: 0, rotation: 0 });
  const children = members.slice(1),
    cellWidth = Math.max(220, ...members.map((node) => sizeOf(node).width));
  const columnGap = 32,
    rowGap = 48,
    groupGap = 72,
    childLeft = cellWidth + 64;
  const inset = width < 600 ? 56 : 88;
  const capacity = Math.max(
    0,
    Math.min(
      3,
      Math.floor(
        (width - inset - 32 - childLeft + columnGap) / (cellWidth + columnGap),
      ),
    ),
  );
  let y = capacity ? 48 : sizeOf(members[0]).height + 64,
    placedGroup = false;
  for (const group of [
    children.filter((node) => node.type !== "note"),
    children.filter((node) => node.type === "note"),
  ]) {
    if (!group.length) continue;
    if (placedGroup) y += groupGap - rowGap;
    // Four siblings form a balanced 2×2 grid instead of a row of three plus one.
    const columns = capacity
      ? Math.ceil(group.length / Math.ceil(group.length / capacity))
      : 1;
    for (let start = 0; start < group.length; start += columns) {
      const row = group.slice(start, start + columns);
      row.forEach((node, column) => {
        positions.set(node.id, {
          x: capacity ? childLeft + column * (cellWidth + columnGap) : 0,
          y,
          rotation: 0,
        });
      });
      y += Math.max(...row.map((node) => sizeOf(node).height)) + rowGap;
    }
    placedGroup = true;
  }
  return positions;
}

// A shared trunk and row rails keep every connector in the card gutters.
// Animated card positions may be supplied while the final grid defines its rows.
export function focusConnectors(
  nodes,
  rootId,
  positions,
  sizeOf,
  visualPositions = positions,
) {
  const members = focusNodes(nodes, rootId),
    root = members[0],
    children = members.slice(1);
  if (!root || !children.length) return [];
  const rootPosition = visualPositions.get(rootId),
    rootPin = {
      x: rootPosition.x + sizeOf(root).width / 2,
      y: rootPosition.y + 1,
    };
  const stacked = children.every(
    (node) => positions.get(node.id).x === positions.get(rootId).x,
  );
  const trunkX = stacked
    ? positions.get(rootId).x - 24
    : Math.min(...children.map((node) => positions.get(node.id).x)) - 32;
  const rootRail = rootPosition.y - 20,
    rows = new Map(),
    paths = [];
  for (const node of children) {
    const key = positions.get(node.id).y;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(node);
  }
  const railYs = [];
  for (const row of rows.values()) {
    const railY =
      Math.min(...row.map((node) => visualPositions.get(node.id).y)) - 24;
    const pins = row.map((node) => ({
      node,
      x: visualPositions.get(node.id).x + sizeOf(node).width / 2,
      y: visualPositions.get(node.id).y + 1,
    }));
    railYs.push(railY);
    paths.push({
      kind: "row",
      points: [
        { x: trunkX, y: railY },
        { x: Math.max(...pins.map((pin) => pin.x)), y: railY },
      ],
    });
    for (const pin of pins)
      paths.push({
        kind: "branch",
        id: pin.node.id,
        note: root.type === "note" || pin.node.type === "note",
        points: [
          { x: pin.x, y: railY },
          { x: pin.x, y: pin.y },
        ],
      });
  }
  paths.unshift(
    {
      kind: "root",
      points: [
        rootPin,
        { x: rootPin.x, y: rootRail },
        { x: trunkX, y: rootRail },
      ],
    },
    {
      kind: "trunk",
      points: [
        { x: trunkX, y: Math.min(rootRail, ...railYs) },
        { x: trunkX, y: Math.max(rootRail, ...railYs) },
      ],
    },
  );
  return paths;
}

// view.mjs

export const inject = ["react", "pages", "relay"];
// build.mjs embeds only this scoped stylesheet; no global CSS, iframe or remote script.
export const BLUEPRINT_STYLE = ".opcb-blueprint {\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  min-height: 0;\n  min-width: 0;\n  color: var(--text);\n  font: inherit;\n}\n.opcb-blueprint .bp-toolbar {\n  display: flex;\n  align-items: center;\n  gap: var(--space-2, 8px);\n  flex-wrap: wrap;\n  padding: var(--space-2, 8px) var(--space-3, 12px);\n  border-bottom: 1px solid var(--border);\n}\n.opcb-blueprint .bp-toolbar label {\n  display: flex;\n  align-items: center;\n  gap: var(--space-1, 4px);\n  min-width: 0;\n}\n.opcb-blueprint .bp-toolbar select {\n  max-width: 220px;\n  min-width: 100px;\n}\n.opcb-blueprint .bp-field {\n  border: 1px solid var(--border-input);\n  border-radius: var(--corner-control, 8px);\n  background: var(--surface-input);\n  padding: 8px 10px;\n  min-width: 0;\n  font: inherit;\n}\n.opcb-blueprint .bp-spacer {\n  flex: 1;\n}\n.opcb-blueprint .bp-toolbar :is(label, select, option, input, button),\n.opcb-blueprint .bp-context button {\n  font-family: inherit;\n  font-size: var(--text-label-sm, 0.875rem);\n  line-height: var(--text-label-sm--line-height, 1.43);\n  letter-spacing: var(--text-label-sm--letter-spacing, 0.0025em);\n  font-weight: var(--text-label-sm--font-weight, 500);\n}\n.opcb-blueprint .bp-toolbar :is(select, input, button),\n.opcb-blueprint .bp-context button {\n  min-height: 2rem;\n  height: auto;\n  padding: 5px 10px;\n}\n.opcb-blueprint .bp-toolbar button {\n  white-space: nowrap;\n}\n.opcb-blueprint .bp-status {\n  font-size: var(--text-caption, 0.75rem);\n  line-height: var(--text-caption--line-height, 1.33);\n  letter-spacing: var(--text-caption--letter-spacing, 0.0133em);\n  font-weight: var(--text-caption--font-weight, 400);\n  color: var(--text-muted);\n  overflow-wrap: anywhere;\n}\n.opcb-blueprint .bp-context {\n  display: flex;\n  align-items: center;\n  gap: var(--space-2, 8px);\n  flex-wrap: wrap;\n  padding: 6px 12px;\n  border-bottom: 1px solid var(--border);\n}\n.opcb-blueprint .bp-error {\n  color: var(--danger);\n  padding: 10px 16px;\n  background: var(--surface);\n  border-bottom: 1px solid var(--border);\n  display: flex;\n  gap: 12px;\n  align-items: center;\n  flex-wrap: wrap;\n}\n.opcb-blueprint .bp-work {\n  display: flex;\n  flex: 1;\n  min-height: 0;\n  min-width: 0;\n  position: relative;\n}\n.opcb-blueprint .bp-canvas {\n  position: relative;\n  flex: 1;\n  min-height: 280px;\n  min-width: 0;\n  overflow: hidden;\n  touch-action: none;\n  outline-offset: -3px;\n  cursor: grab;\n  background: var(--workspace);\n  background-image: radial-gradient(var(--border) 0.7px, transparent 0.7px);\n  background-size: 22px 22px;\n}\n.opcb-blueprint .bp-world {\n  position: absolute;\n  left: 0;\n  top: 0;\n  transform-origin: 0 0;\n  width: 1px;\n  height: 1px;\n}\n.opcb-blueprint .bp-lines {\n  position: absolute;\n  left: 0;\n  top: 0;\n  width: 1px;\n  height: 1px;\n  overflow: visible;\n  pointer-events: none;\n}\n.opcb-blueprint .bp-lines path {\n  fill: none;\n  stroke: var(--text-muted);\n  stroke-width: 1.5;\n  opacity: 0.6;\n}\n.opcb-blueprint .bp-card {\n  position: absolute;\n  width: 240px;\n  height: 178px;\n  padding: 24px 20px 15px;\n  color: #343a33;\n  background: #f7dfd8;\n  border-radius: 3px;\n  box-shadow: 0 5px 13px #1d2a2020;\n  transform-origin: 50% 6px;\n  cursor: grab;\n  outline-offset: 4px;\n  user-select: none;\n}\n.opcb-blueprint .bp-card[data-depth=\"2\"] {\n  background: #f2e8b9;\n}\n.opcb-blueprint .bp-card[data-depth=\"3\"] {\n  background: #d7e7ed;\n}\n.opcb-blueprint .bp-card[data-note=\"true\"] {\n  background: #dae8cf;\n}\n.opcb-blueprint .bp-card[data-selected=\"true\"] {\n  outline: 2px solid var(--focus);\n}\n.opcb-blueprint .bp-pin {\n  position: absolute;\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  top: 6px;\n  left: calc(50% - 4px);\n  background: #a85c4d;\n  box-shadow: 1px 2px 3px #343a3350;\n}\n.opcb-blueprint .bp-card h3 {\n  font-size: 17px;\n  line-height: 1.35;\n  font-weight: 600;\n  margin: 0 0 8px;\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  overflow-wrap: anywhere;\n}\n.opcb-blueprint .bp-card .bp-body {\n  font-size: 13px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  display: -webkit-box;\n  -webkit-line-clamp: 3;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  margin: 0;\n  color: #454e40;\n  overflow-wrap: anywhere;\n}\n.opcb-blueprint .bp-meta {\n  position: absolute;\n  left: 20px;\n  right: 20px;\n  bottom: 14px;\n  display: flex;\n  gap: 10px;\n  font-size: 11px;\n  color: #454e40;\n}\n.opcb-blueprint .bp-meta span {\n  overflow: hidden;\n  white-space: nowrap;\n  text-overflow: ellipsis;\n}\n.opcb-blueprint .bp-progress {\n  position: absolute;\n  bottom: 0;\n  left: 0;\n  height: 3px;\n  background: #55745a;\n  border-radius: 0 0 3px 3px;\n  max-width: 100%;\n}\n.opcb-blueprint .bp-zoom {\n  position: absolute;\n  right: 16px;\n  bottom: 16px;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 6px;\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: var(--radius-pill, 24px);\n  font-variant-numeric: tabular-nums;\n}\n.opcb-blueprint .bp-empty {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  padding: 32px;\n  text-align: center;\n  cursor: default;\n  gap: 12px;\n}\n.opcb-blueprint .bp-empty h2 {\n  margin: 0;\n  font-size: 24px;\n  line-height: 1.4;\n}\n.opcb-blueprint .bp-empty p {\n  max-width: 48ch;\n  margin: 0;\n  color: var(--text-muted);\n}\n.opcb-blueprint .bp-editor {\n  width: 310px;\n  max-width: 45%;\n  flex: none;\n  padding: 20px;\n  overflow: auto;\n  border-left: 1px solid var(--border);\n  background: var(--surface);\n  display: flex;\n  flex-direction: column;\n  gap: 14px;\n}\n.opcb-blueprint .bp-editor h2 {\n  margin: 0;\n  font-size: var(--text-label, 1rem);\n  line-height: var(--text-label--line-height, 1.5);\n  letter-spacing: var(--text-label--letter-spacing, 0);\n  font-weight: var(--text-label--font-weight, 500);\n}\n.opcb-blueprint .bp-editor label {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  font-size: var(--text-label, 13px);\n}\n.opcb-blueprint .bp-editor textarea {\n  min-height: 120px;\n  resize: vertical;\n}\n.opcb-blueprint .bp-editor .bp-row {\n  display: flex;\n  gap: 10px;\n  align-items: center;\n}\n.opcb-blueprint .bp-row > * {\n  min-width: 0;\n}\n.opcb-blueprint .bp-editor .bp-row label {\n  flex: 1;\n}\n.opcb-blueprint .bp-editor .bp-help {\n  color: var(--text-muted);\n  font-size: var(--text-label, 13px);\n  line-height: 1.5;\n}\n.opcb-blueprint .bp-editor .bp-help {\n  font-size: var(--text-body, 0.875rem);\n  line-height: var(--text-body--line-height, 1.43);\n  letter-spacing: var(--text-body--letter-spacing, -0.005em);\n  font-weight: var(--text-body--font-weight, 400);\n  margin: 0;\n}\n.opcb-blueprint .bp-access-list {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n.opcb-blueprint .bp-editor .bp-access-member {\n  display: flex;\n  flex-direction: row;\n  align-items: center;\n  gap: 10px;\n  padding: 8px 0;\n  cursor: pointer;\n}\n.opcb-blueprint .bp-access-member input {\n  flex: none;\n}\n.opcb-blueprint .bp-access-member span {\n  min-width: 0;\n  overflow-wrap: anywhere;\n}\n.opcb-blueprint .bp-access-member small {\n  display: block;\n  color: var(--text-muted);\n  font-size: var(--text-caption, 0.75rem);\n  line-height: 1.33;\n}\n.opcb-blueprint .bp-breadcrumb {\n  display: flex;\n  gap: 4px;\n  align-items: center;\n  min-width: 0;\n  overflow: auto;\n  max-width: 100%;\n}\n.opcb-blueprint .bp-breadcrumb button {\n  white-space: nowrap;\n  max-width: 200px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.opcb-blueprint .bp-results {\n  max-height: 180px;\n  overflow: auto;\n  display: flex;\n  gap: 6px;\n  flex-wrap: wrap;\n  padding: 8px 16px;\n}\n.opcb-blueprint .bp-results button {\n  max-width: 240px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.opcb-blueprint .bp-icon {\n  width: 18px;\n  height: 18px;\n  display: inline-block;\n  vertical-align: middle;\n  fill: none;\n  stroke: currentColor;\n  stroke-width: 1.7;\n  stroke-linecap: round;\n  stroke-linejoin: round;\n}\n.opcb-blueprint\n  :where(button, input, select, textarea, [tabindex]):focus-visible {\n  outline: 2px solid var(--focus);\n  outline-offset: 3px;\n}\n.opcb-blueprint .bp-footer {\n  padding: 6px 16px;\n  display: flex;\n  gap: 12px;\n  flex-wrap: wrap;\n  font-size: 11px;\n  color: var(--text-muted);\n  border-top: 1px solid var(--border);\n}\n@media (max-width: 700px) {\n  .opcb-blueprint .bp-toolbar {\n    padding: 10px;\n    gap: 6px;\n  }\n  .opcb-blueprint .bp-toolbar select {\n    max-width: 170px;\n  }\n  .opcb-blueprint .bp-work {\n    flex-direction: column;\n  }\n  .opcb-blueprint .bp-editor {\n    width: 100%;\n    max-width: none;\n    max-height: 50%;\n    border-left: 0;\n    border-top: 1px solid var(--border);\n    padding: 16px;\n  }\n  .opcb-blueprint .bp-canvas {\n    min-height: 260px;\n  }\n  .opcb-blueprint .bp-spacer {\n    display: none;\n  }\n}\n@media (prefers-reduced-motion: no-preference) {\n  .opcb-blueprint .bp-card {\n    transition: box-shadow 0.15s ease-out;\n  }\n  .opcb-blueprint .bp-card:hover {\n    box-shadow: 0 8px 18px #1d2a2030;\n  }\n}\n";
export function apply(ctx) {
  const React = ctx.react,
    h = React.createElement;
  const sessions = new WeakMap();
  function storeFor(session) {
    if (!sessions.has(session))
      sessions.set(
        session,
        createBlueprintStore(
          session,
          () => ctx.relay.snapshot().session === session,
        ),
      );
    return sessions.get(session);
  }
  const button = (text, onClick, disabled = false, extra = {}) =>
    h("button", { type: "button", onClick, disabled, ...extra }, text);
  const icon = (kind) =>
    h(
      "svg",
      { className: "bp-icon", viewBox: "0 0 24 24", "aria-hidden": true },
      h("path", {
        d: {
          plus: "M12 5v14M5 12h14",
          minus: "M5 12h14",
          fit: "M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6",
          edit: "M12 6H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7M16 3l5 5M9 15l-1 5 5-1L22 10a2 2 0 0 0-5-5z",
        }[kind],
      }),
    );
  function exportJson(board) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(normalizeBoard(board), null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${board.title.replace(/[\\/:*?"<>|]/g, "-") || "Blueprint"}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function Blueprint() {
    const relay = React.useSyncExternalStore(
      ctx.relay.subscribe,
      ctx.relay.snapshot,
    );
    // A different connection/identity remounts all page-local drafts and aborts old I/O.
    return h(Workspace, {
      key: `${relay.scope ?? "none"}:${relay.generation}`,
      relay,
    });
  }
  function Workspace({ relay }) {
    const session = relay.session,
      store = storeFor(session);
    const channelList = React.useSyncExternalStore(
      session.channels.subscribeList,
      session.channels.list,
    );
    const profiles = React.useSyncExternalStore(
      session.profiles.subscribe,
      session.profiles.snapshot,
    );
    const [channelId, setChannelId] = React.useState("");
    const [records, setRecords] = React.useState([]),
      [record, setRecord] = React.useState(null);
    const [board, setBoard] = React.useState(null),
      [dirty, setDirty] = React.useState(false);
    const [busy, setBusy] = React.useState(false),
      [error, setError] = React.useState(""),
      [status, setStatus] = React.useState("选择共享频道，再打开或新建蓝图。");
    const [discard, setDiscard] = React.useState(false);
    const [canWrite, setCanWrite] = React.useState(false);
    const [accessDraft, setAccessDraft] = React.useState(null);
    const [selected, setSelected] = React.useState(null),
      [focusId, setFocusId] = React.useState(null),
      [editor, setEditor] = React.useState(null);
    const [view, setView] = React.useState({ x: 60, y: 65, scale: 1 }),
      [dragPosition, setDragPosition] = React.useState(null),
      [search, setSearch] = React.useState("");
    const [size, setSize] = React.useState({ width: 900, height: 600 });
    const canvasRef = React.useRef(null),
      fileRef = React.useRef(null),
      gesture = React.useRef(null),
      controller = React.useRef(null),
      epoch = React.useRef(0),
      busyRef = React.useRef(false);
    const channels = channelList.channels.filter(
      (item) => !item.archived && item.channelType !== "system",
    );
    function channelName(item) {
      if (item.channelType !== "dm") return item.name || "未命名频道";
      const people = (item.participants ?? item.members ?? []).filter(
        (id) => id !== session.viewer,
      );
      return people.length
        ? `私聊 · ${people.map((id) => profiles?.get(id)?.name || id.slice(0, 8)).join("、")}`
        : "个人私聊";
    }
    const online = relay.status === "ready" && !relay.cached;
    const channelWritable =
      online &&
      canWrite &&
      channelId &&
      writableChannel(session, channelId) &&
      !!session.configArtifactWriter;
    const permissions = blueprintAccess(record, session.viewer);
    const editable =
      channelWritable && (record?.revision === null || permissions.canEdit);
    const locked = busy || !editable || !!editor || !!accessDraft || dirty;
    const createLocked =
      busy || !channelWritable || !!editor || !!accessDraft || dirty;
    const memberName = (key) =>
      profiles.get(key)?.name || `${key.slice(0, 8)}…${key.slice(-4)}`;
    React.useEffect(() => {
      session.channels.ensureList();
      return () => {
        epoch.current++;
        controller.current?.abort();
      };
    }, [session]);
    React.useEffect(() => {
      const element = canvasRef.current;
      if (!element) return;
      const observer = new ResizeObserver(() =>
        setSize({ width: element.clientWidth, height: element.clientHeight }),
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, [board]);
    function start() {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      const generation = ++epoch.current;
      busyRef.current = true;
      setBusy(true);
      setError("");
      return {
        signal: current.signal,
        valid: () =>
          !current.signal.aborted &&
          epoch.current === generation &&
          ctx.relay.snapshot().session === session,
        done: () => {
          if (epoch.current === generation) {
            busyRef.current = false;
            setBusy(false);
          }
        },
      };
    }
    async function loadChannel(id) {
      if (dirty || editor || accessDraft) {
        setError("请先保存或关闭当前编辑，再切换频道。");
        return;
      }
      const job = start();
      setCanWrite(false);
      setChannelId(id);
      setRecords([]);
      setRecord(null);
      setBoard(null);
      setFocusId(null);
      setSelected(null);
      try {
        if (!id) return;
        const items = await store.list(id, job.signal);
        let permitted = false,
          reason = "";
        try {
          await store.authority(id, job.signal);
          permitted = true;
        } catch (failure) {
          reason = failure.message;
        }
        if (!job.valid()) return;
        setCanWrite(permitted);
        setRecords(items);
        setStatus(
          !permitted
            ? `当前频道仅可查看：${reason}`
            : items.length
              ? "已从社区读取。其他成员的修改可点击刷新获取。"
              : "此频道还没有蓝图，可新建或导入 JSON。",
        );
        if (items[0]) openRecord(items[0]);
      } catch (failure) {
        if (job.valid()) {
          setError(failure.message);
          setStatus("读取失败，请刷新重试。");
        }
      } finally {
        job.done();
      }
    }
    function openRecord(next) {
      if (dirty || editor) {
        setError("请先保存或导出当前草稿。");
        return;
      }
      setRecord(next);
      setBoard(next.board);
      setDirty(false);
      setSelected(null);
      setFocusId(null);
      setView({ x: 60, y: 65, scale: 1 });
      setError("");
    }
    async function refresh(discard = false) {
      if (!channelId || busyRef.current) return;
      if (accessDraft) {
        setError("请先保存或关闭编辑权限面板。");
        return;
      }
      if ((dirty || editor) && !discard) {
        setError("草稿尚未保存。可导出草稿，或选择“放弃草稿并刷新”。");
        return;
      }
      const job = start();
      try {
        const items = await store.list(channelId, job.signal);
        let permitted = false;
        try {
          await store.authority(channelId, job.signal);
          permitted = true;
        } catch {
          /* Preserve readable boards for guests. */
        }
        if (!job.valid()) return;
        setCanWrite(permitted);
        const next = record
          ? items.find((item) => item.id === record.id)
          : items[0];
        setRecords(items);
        setEditor(null);
        setDirty(false);
        setDiscard(false);
        setRecord(next ?? null);
        setBoard(next?.board ?? null);
        setSelected(null);
        setFocusId(null);
        setStatus(permitted ? "已从社区刷新。" : "已刷新；当前频道仅可查看。");
      } catch (failure) {
        if (job.valid()) setError(failure.message);
      } finally {
        job.done();
      }
    }
    async function save(nextBoard, base = record) {
      if (!base || busyRef.current || !editable) return false;
      const clean = normalizeBoard(nextBoard);
      setBoard(clean);
      setDirty(true);
      const job = start();
      setStatus("正在保存到社区…");
      try {
        const saved = await store.save(channelId, base, clean, job.signal);
        if (!job.valid()) return false;
        setRecord(saved);
        setBoard(saved.board);
        setDirty(false);
        setRecords((items) => [
          saved,
          ...items.filter((item) => item.id !== saved.id),
        ]);
        setStatus("已保存到社区，并已回读确认。");
        return true;
      } catch (failure) {
        if (job.valid()) {
          setError(failure.message);
          setStatus("草稿尚未确认保存。");
        }
        return false;
      } finally {
        job.done();
      }
    }
    async function mutate(operation) {
      if (locked || !board) return;
      try {
        await save(changeBoard(board, operation));
      } catch (failure) {
        setError(failure.message);
      }
    }
    async function openAccess() {
      if (!record?.revision || dirty || editor || busyRef.current) return;
      const job = start();
      try {
        await store.authority(channelId, job.signal);
        const fresh = await store.head(channelId, record.id, job.signal);
        if (!job.valid()) return;
        if (!blueprintAccess(fresh, session.viewer).canManage)
          throw new Error("只有蓝图管理员可以设置编辑者，请刷新确认当前权限。");
        setRecord(fresh);
        setBoard(fresh.board);
        setRecords((items) =>
          items.map((item) => (item.id === fresh.id ? fresh : item)),
        );
        setAccessDraft({ base: fresh, editors: [...fresh.access.editors] });
      } catch (failure) {
        if (job.valid()) setError(failure.message);
      } finally {
        job.done();
      }
    }
    async function saveAccess(event) {
      event.preventDefault();
      if (!accessDraft || busyRef.current) return;
      const job = start();
      try {
        const saved = await store.setEditors(
          channelId,
          accessDraft.base,
          accessDraft.editors,
          job.signal,
        );
        if (!job.valid()) return;
        setRecord(saved);
        setBoard(saved.board);
        setRecords((items) =>
          items.map((item) => (item.id === saved.id ? saved : item)),
        );
        setAccessDraft(null);
        setStatus("编辑者名单已保存并回读确认。其他成员默认只读。");
      } catch (failure) {
        if (job.valid()) setError(failure.message);
      } finally {
        job.done();
      }
    }
    function newBoard() {
      if (createLocked || !channelId) return;
      const next = {
        id: crypto.randomUUID(),
        revision: null,
        board: blankBoard(),
      };
      setRecord(next);
      setBoard(next.board);
      setDirty(false);
      setFocusId(null);
      setSelected(null);
      setEditor({ kind: "board", title: next.board.title, base: next });
      setError("");
    }
    function newNode(type, parentId = null) {
      if (locked || !board) return;
      const parent = board.nodes.find((node) => node.id === parentId);
      if (type === "project" && parent && nodeDepth(board, parent) >= 3) return;
      const node = {
        id: crypto.randomUUID(),
        type,
        parentId: type === "project" ? parentId : null,
        linkedProjectId: type === "note" ? parentId : null,
        title: "",
        body: "",
        x: parent
          ? parent.x + 320
          : (size.width / 2 - view.x) / view.scale - 120,
        y: parent
          ? parent.y + 80
          : (size.height / 2 - view.y) / view.scale - 89,
        rotation: 0,
        status: "todo",
        owner: "",
        progress: 0,
        collapsed: false,
        updatedAt: new Date().toISOString(),
      };
      setEditor({ kind: "create", node, base: record });
      setError("");
    }
    function editNode(node) {
      if (!locked) {
        setSelected(node.id);
        setEditor({ kind: "update", node: { ...node }, base: record });
        setError("");
      }
    }
    async function saveEditor(event) {
      event.preventDefault();
      if (!editor || busyRef.current) return;
      try {
        let next;
        if (editor.kind === "board")
          next = normalizeBoard({ ...board, title: editor.title });
        else if (editor.kind === "delete")
          next = changeBoard(board, { type: "delete", id: editor.node.id });
        else if (editor.kind === "create")
          next = changeBoard(board, {
            type: "create",
            node: {
              ...editor.node,
              title: editor.node.title.trim() || "未命名便签",
            },
          });
        else {
          const { id, type, updatedAt, ...patch } = editor.node;
          next = changeBoard(board, { type: "update", id, patch });
        }
        if (await save(next, editor.base)) {
          setEditor(null);
          if (editor.kind === "delete") setSelected(null);
        }
      } catch (failure) {
        setError(failure.message);
      }
    }
    function editorDraft() {
      if (!editor || !board) return board;
      if (editor.kind === "board")
        return { ...board, title: editor.title || board.title };
      if (editor.kind === "create")
        return changeBoard(board, { type: "create", node: editor.node });
      if (editor.kind === "update") {
        const { id, type, updatedAt, ...patch } = editor.node;
        return changeBoard(board, { type: "update", id, patch });
      }
      return board;
    }
    function exportDraft() {
      try {
        exportJson(editorDraft());
      } catch (failure) {
        setError(failure.message);
      }
    }
    async function importFile(event) {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || createLocked || !channelId) return;
      const job = start();
      try {
        if (file.size > 2 * 1024 * 1024)
          throw new Error("请选择小于 2 MiB 的导出 JSON。");
        const value = normalizeBoard(JSON.parse(await file.text()));
        if (!job.valid()) return;
        const next = { id: crypto.randomUUID(), revision: null, board: value };
        setRecord(next);
        setBoard(value);
        setDirty(true);
        setEditor(null);
        setFocusId(null);
        setSelected(null);
        setStatus("已读入草稿，保存后会成为此频道的一张新蓝图。");
        setError("");
      } catch (failure) {
        if (job.valid()) setError(failure.message);
      } finally {
        job.done();
      }
    }
    const shown = board ? visibleBoardNodes(board, focusId) : [];
    const nodeSize = () => ({ width: 240, height: 178 });
    const positions =
      focusId && board
        ? focusLayout(board.nodes, focusId, nodeSize, size.width / view.scale)
        : null;
    function position(node) {
      return dragPosition?.id === node.id
        ? dragPosition
        : (positions?.get(node.id) ?? node);
    }
    function focus(node) {
      setFocusId(node?.id ?? null);
      setSelected(node?.id ?? null);
      setView({ x: 60, y: 60, scale: 1 });
    }
    function fitCanvas() {
      if (!shown.length) return;
      const xs = shown.map((node) => position(node).x),
        ys = shown.map((node) => position(node).y);
      const minX = Math.min(...xs),
        minY = Math.min(...ys),
        width = Math.max(...xs) - minX + 240,
        height = Math.max(...ys) - minY + 178;
      const scale = Math.max(
        0.2,
        Math.min(1.4, (size.width - 80) / width, (size.height - 80) / height),
      );
      setView({
        scale,
        x: (size.width - width * scale) / 2 - minX * scale,
        y: (size.height - height * scale) / 2 - minY * scale,
      });
    }
    function zoom(multiplier) {
      setView((old) => {
        const scale = Math.max(0.2, Math.min(2.5, old.scale * multiplier));
        const cx = size.width / 2,
          cy = size.height / 2;
        return {
          scale,
          x: cx - ((cx - old.x) * scale) / old.scale,
          y: cy - ((cy - old.y) * scale) / old.scale,
        };
      });
    }
    function pointerDown(event) {
      if (
        event.button !== 0 ||
        event.target.closest("button,input,select,textarea")
      )
        return;
      const id = event.target.closest("[data-node-id]")?.dataset.nodeId,
        node = board?.nodes.find((item) => item.id === id);
      gesture.current = {
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        view,
        node,
        moving: false,
        canMove: node && !locked && !focusId,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      if (node) setSelected(node.id);
    }
    function pointerMove(event) {
      const action = gesture.current;
      if (!action || action.pointer !== event.pointerId) return;
      const dx = event.clientX - action.startX,
        dy = event.clientY - action.startY;
      if (Math.hypot(dx, dy) < 6 && !action.moving) return;
      action.moving = true;
      if (action.canMove)
        setDragPosition({
          id: action.node.id,
          x: action.node.x + dx / view.scale,
          y: action.node.y + dy / view.scale,
          rotation: action.node.rotation,
        });
      else
        setView({
          ...action.view,
          x: action.view.x + dx,
          y: action.view.y + dy,
        });
    }
    function pointerUp(event) {
      const action = gesture.current;
      if (!action || action.pointer !== event.pointerId) return;
      gesture.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (action.moving && action.canMove) {
        const patch = {
          x: action.node.x + (event.clientX - action.startX) / view.scale,
          y: action.node.y + (event.clientY - action.startY) / view.scale,
        };
        setDragPosition(null);
        void mutate({ type: "update", id: action.node.id, patch });
      } else if (!action.moving && action.node && !editor) focus(action.node);
    }
    const selectedNode = board?.nodes.find((node) => node.id === selected);
    const trail = board && focusId ? focusTrail(board.nodes, focusId) : [];
    const pathElements =
      focusId && board
        ? focusConnectors(board.nodes, focusId, positions, nodeSize).map(
            (path, index) =>
              h("path", {
                key: index,
                d: path.points
                  .map(
                    (point, part) => `${part ? "L" : "M"}${point.x},${point.y}`,
                  )
                  .join(" "),
                strokeDasharray: path.note ? "4 4" : undefined,
              }),
          )
        : shown.flatMap((node) => {
            const parent = shown.find(
              (item) => item.id === (node.parentId || node.linkedProjectId),
            );
            if (!parent) return [];
            const a = position(parent),
              b = position(node);
            return [
              h("path", {
                key: node.id,
                d: `M${a.x + 120},${a.y + 6} C${a.x + 120},${a.y - 45} ${b.x + 120},${b.y - 45} ${b.x + 120},${b.y + 6}`,
                strokeDasharray: node.type === "note" ? "4 4" : undefined,
              }),
            ];
          });
    function field(label, key, options = {}) {
      const value = editor.node[key];
      const onChange = (event) =>
        setEditor((old) => ({
          ...old,
          node: {
            ...old.node,
            [key]: options.numeric
              ? Number(event.target.value)
              : event.target.value || (options.nullable ? null : ""),
          },
        }));
      return h(
        "label",
        { key },
        label,
        options.choices
          ? h(
              "select",
              {
                className: "bp-field",
                value: value ?? "",
                onChange,
                disabled: busy,
              },
              options.choices.map(([id, title]) =>
                h("option", { key: id, value: id }, title),
              ),
            )
          : h(options.multiline ? "textarea" : "input", {
              className: "bp-field",
              value,
              onChange,
              disabled: busy,
              type: options.numeric ? "number" : "text",
              min: options.min,
              max: options.max,
              maxLength: options.maxLength,
              required: key === "title",
            }),
      );
    }
    const editorPanel =
      editor &&
      h(
        "form",
        {
          className: "bp-editor",
          onSubmit: saveEditor,
          "aria-label": "便签编辑",
        },
        h(
          "h2",
          null,
          editor.kind === "board"
            ? "蓝图名称"
            : editor.kind === "delete"
              ? "删除便签"
              : editor.kind === "create"
                ? "添加便签"
                : "编辑便签",
        ),
        editor.kind === "board"
          ? h(
              "label",
              null,
              "名称",
              h("input", {
                className: "bp-field",
                value: editor.title,
                required: true,
                maxLength: 200,
                disabled: busy,
                onChange: (event) =>
                  setEditor({ ...editor, title: event.target.value }),
              }),
            )
          : editor.kind === "delete"
            ? h(
                "p",
                null,
                `将删除“${editor.node.title}”及其 ${descendantIds(board, editor.node.id).size - 1} 张下级便签。关联说明会保留并解除关联。`,
              )
            : h(
                React.Fragment,
                null,
                field("标题", "title", { maxLength: 200 }),
                field("内容", "body", { multiline: true, maxLength: 20000 }),
                field("负责人（显示名称）", "owner", { maxLength: 100 }),
                h(
                  "div",
                  { className: "bp-row" },
                  field("状态", "status", {
                    choices: Object.entries(BLUEPRINT_STATUS),
                  }),
                  field("进度 %", "progress", {
                    numeric: true,
                    min: 0,
                    max: 100,
                  }),
                ),
                field("旋转角度", "rotation", {
                  numeric: true,
                  min: -360,
                  max: 360,
                }),
                editor.node.type === "note"
                  ? field("关联项目", "linkedProjectId", {
                      nullable: true,
                      choices: [
                        ["", "独立说明"],
                        ...board.nodes
                          .filter((node) => node.type === "project")
                          .map((node) => [node.id, node.title]),
                      ],
                    })
                  : field("上级项目", "parentId", {
                      nullable: true,
                      choices: [
                        ["", "一级项目"],
                        ...board.nodes
                          .filter(
                            (node) =>
                              node.type === "project" &&
                              nodeDepth(board, node) < 3 &&
                              !descendantIds(board, editor.node.id).has(
                                node.id,
                              ),
                          )
                          .map((node) => [node.id, node.title]),
                      ],
                    }),
              ),
        h(
          "p",
          { className: "bp-help" },
          "只有蓝图管理员和已授权编辑者可以通过本插件修改内容。负责人名称不影响授权。",
        ),
        h(
          "div",
          { className: "bp-row" },
          h(
            "button",
            { type: "submit", disabled: busy || !editable },
            busy ? "保存中…" : editor.kind === "delete" ? "确认删除" : "保存",
          ),
          button(
            "取消编辑",
            () => {
              setEditor(null);
              setError("");
            },
            busy,
          ),
        ),
        button("导出草稿", exportDraft, false),
      );
    const accessMembers = accessDraft
      ? [
          ...new Set([
            ...(session.channels.get(channelId)?.members ?? []),
            ...accessDraft.editors,
          ]),
        ].filter((key) => key !== accessDraft.base.access.admin)
      : [];
    const accessPanel =
      accessDraft &&
      h(
        "form",
        {
          className: "bp-editor",
          onSubmit: saveAccess,
          "aria-label": "编辑权限",
        },
        h("h2", null, "谁可以编辑"),
        h(
          "p",
          { className: "bp-help" },
          `管理员：${memberName(accessDraft.base.access.admin)}。未勾选的频道成员默认只读。`,
        ),
        h(
          "div",
          { className: "bp-access-list" },
          accessMembers.length
            ? accessMembers.map((key) => {
                const present = session.channels
                  .get(channelId)
                  ?.members?.includes(key);
                return h(
                  "label",
                  { key, className: "bp-access-member" },
                  h("input", {
                    type: "checkbox",
                    checked: accessDraft.editors.includes(key),
                    disabled:
                      busy || (!present && !accessDraft.editors.includes(key)),
                    onChange: (event) =>
                      setAccessDraft((draft) => ({
                        ...draft,
                        editors: event.target.checked
                          ? [...draft.editors, key]
                          : draft.editors.filter((item) => item !== key),
                      })),
                  }),
                  h(
                    "span",
                    null,
                    memberName(key),
                    h(
                      "small",
                      null,
                      `${key.slice(0, 8)}…${key.slice(-4)}${present ? "" : " · 已离开频道，请取消勾选"}`,
                    ),
                  ),
                );
              })
            : h(
                "p",
                { className: "bp-help" },
                "频道目前只有你。先在 Buzz 频道成员管理中添加同事，再刷新这里。",
              ),
        ),
        h(
          "p",
          { className: "bp-help" },
          "用于团队防误改，名单随蓝图保存。它不是服务器安全权限，不能防止绕过插件的修改。",
        ),
        h(
          "div",
          { className: "bp-row" },
          h(
            "button",
            { type: "submit", disabled: busy },
            busy ? "保存中…" : "保存授权",
          ),
          button(
            "关闭",
            () => {
              setAccessDraft(null);
              setError("");
            },
            busy,
          ),
        ),
      );
    const accessMessage = record?.revision
      ? !record.access
        ? "旧版蓝图仅供查看；导出后重新导入即可设置编辑权限。"
        : permissions.canManage
          ? `你是管理员 · ${record.access.editors.length} 位授权编辑者`
          : permissions.canEdit
            ? "你已获授权，可编辑整张蓝图。"
            : `仅可查看 · 请联系 ${memberName(record.access.admin)} 授权编辑。`
      : board
        ? "新蓝图默认仅你可编辑；保存后可设置编辑者。"
        : "";
    return h(
      "section",
      { className: "opcb-blueprint", "aria-label": "Blueprint" },
      h("style", null, BLUEPRINT_STYLE),
      h(
        "div",
        { className: "bp-toolbar" },
        h(
          "label",
          null,
          "共享频道",
          h(
            "select",
            {
              className: "bp-field",
              value: channelId,
              disabled: busy || dirty || !!editor || !!accessDraft || !online,
              onChange: (event) => void loadChannel(event.target.value),
            },
            h("option", { value: "" }, online ? "选择频道" : "等待社区连接"),
            channels.map((item) =>
              h("option", { key: item.id, value: item.id }, channelName(item)),
            ),
          ),
        ),
        h(
          "label",
          null,
          "蓝图",
          h(
            "select",
            {
              className: "bp-field",
              value: record?.id ?? "",
              disabled:
                busy || dirty || !!editor || !!accessDraft || !channelId,
              onChange: (event) => {
                const item = records.find(
                  (entry) => entry.id === event.target.value,
                );
                if (item) openRecord(item);
              },
            },
            h(
              "option",
              {
                value:
                  record && !records.some((item) => item.id === record.id)
                    ? record.id
                    : "",
              },
              record && !records.some((item) => item.id === record.id)
                ? record.board.title
                : "选择蓝图",
            ),
            records.map((item) =>
              h("option", { key: item.id, value: item.id }, item.board.title),
            ),
          ),
        ),
        button("新建蓝图", newBoard, createLocked || !channelId),
        button(
          "刷新",
          () => void refresh(),
          busy || !online || !channelId || !!accessDraft,
        ),
        h("span", { className: "bp-spacer" }),
        button(
          "导入 JSON",
          () => fileRef.current?.click(),
          createLocked || !channelId,
        ),
        button(dirty || editor ? "导出草稿" : "导出 JSON", exportDraft, !board),
        h("input", {
          type: "file",
          accept: ".json,application/json",
          hidden: true,
          ref: fileRef,
          onChange: importFile,
        }),
      ),
      error &&
        h(
          "div",
          { className: "bp-error", role: "alert" },
          h("span", null, error),
          (dirty || editor) &&
            (discard
              ? h(
                  React.Fragment,
                  null,
                  h("span", null, "确定放弃本地草稿？"),
                  button("确认放弃并刷新", () => void refresh(true), busy),
                  button("保留草稿", () => setDiscard(false)),
                )
              : button("放弃草稿并刷新", () => setDiscard(true), busy)),
        ),
      board &&
        h(
          "div",
          { className: "bp-toolbar" },
          button("添加项目", () => newNode("project"), locked),
          button(
            "添加说明",
            () =>
              newNode(
                "note",
                selectedNode?.type === "project" ? selectedNode.id : null,
              ),
            locked,
          ),
          selectedNode?.type === "project" &&
            button(
              "添加下级",
              () => newNode("project", selectedNode.id),
              locked || nodeDepth(board, selectedNode) >= 3,
            ),
          selectedNode &&
            button("编辑便签", () => editNode(selectedNode), locked),
          selectedNode?.type === "project" &&
            button(
              selectedNode.collapsed ? "展开下级" : "折叠下级",
              () =>
                void mutate({
                  type: "update",
                  id: selectedNode.id,
                  patch: { collapsed: !selectedNode.collapsed },
                }),
              locked || !!focusId,
            ),
          selectedNode &&
            button(
              "删除便签",
              () =>
                setEditor({ kind: "delete", node: selectedNode, base: record }),
              locked,
            ),
          button(
            "重命名",
            () =>
              setEditor({ kind: "board", title: board.title, base: record }),
            locked,
          ),
          permissions.canManage &&
            record?.revision &&
            button("编辑权限", () => void openAccess(), locked),
          dirty &&
            !editor &&
            button("保存草稿", () => void save(board), busy || !editable),
          h("span", { className: "bp-spacer" }),
          h("input", {
            className: "bp-field",
            type: "search",
            value: search,
            placeholder: "搜索便签",
            "aria-label": "搜索便签",
            onChange: (event) => setSearch(event.target.value),
          }),
        ),
      h(
        "div",
        { className: "bp-context" },
        board &&
          h(
            "div",
            { className: "bp-breadcrumb", "aria-label": "蓝图路径" },
            button("全图", () => focus(null)),
            trail.map((node) =>
              button(node.title, () => focus(node), false, { key: node.id }),
            ),
          ),
        accessMessage && h("span", { className: "bp-status" }, accessMessage),
        h("span", { className: "bp-spacer" }),
        h(
          "span",
          { className: "bp-status", role: "status" },
          !online ? "当前离线，仅可查看与导出。" : status,
        ),
      ),
      search &&
        board &&
        h(
          "div",
          { className: "bp-results" },
          board.nodes
            .filter((node) =>
              `${node.title} ${node.body} ${node.owner}`
                .toLocaleLowerCase()
                .includes(search.toLocaleLowerCase()),
            )
            .map((node) =>
              button(
                node.title,
                () => {
                  focus(node);
                  setSearch("");
                },
                false,
                { key: node.id },
              ),
            ),
        ),
      h(
        "div",
        { className: "bp-work" },
        h(
          "div",
          {
            className: "bp-canvas",
            ref: canvasRef,
            tabIndex: 0,
            "aria-label": "蓝图画布，拖动空白平移，单击便签聚焦，双击编辑",
            onPointerDown: pointerDown,
            onPointerMove: pointerMove,
            onPointerUp: pointerUp,
            onPointerCancel: () => {
              gesture.current = null;
              setDragPosition(null);
            },
            onKeyDown: (event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Escape") focus(null);
              if (event.key === "+" || event.key === "=") zoom(1.2);
              if (event.key === "-") zoom(1 / 1.2);
              if (event.key.toLowerCase() === "f") fitCanvas();
            },
          },
          !board
            ? h(
                "div",
                { className: "bp-empty" },
                h("h2", null, "Blueprint"),
                h(
                  "p",
                  null,
                  busy
                    ? "正在读取社区蓝图…"
                    : channelId
                      ? channelWritable
                        ? "新建一张蓝图，或导入原应用导出的 JSON。保存后，其他成员默认只能查看。"
                        : "当前频道仅可查看。上方会显示原因，可点击刷新重新确认。"
                      : "先在上方选择共享频道。原应用的内容需要通过 JSON 导入。",
                ),
                channelId &&
                  channelWritable &&
                  button("新建蓝图", newBoard, createLocked),
              )
            : h(
                React.Fragment,
                null,
                h(
                  "div",
                  {
                    className: "bp-world",
                    style: {
                      transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})`,
                    },
                  },
                  h(
                    "svg",
                    { className: "bp-lines", "aria-hidden": true },
                    pathElements,
                  ),
                  shown.map((node) => {
                    const point = position(node);
                    return h(
                      "article",
                      {
                        key: node.id,
                        className: "bp-card",
                        "data-node-id": node.id,
                        "data-depth": nodeDepth(board, node),
                        "data-note": node.type === "note",
                        "data-selected": selected === node.id,
                        tabIndex: 0,
                        style: {
                          left: point.x,
                          top: point.y,
                          transform: `rotate(${point.rotation || 0}deg)`,
                        },
                        "aria-label": `${node.title}，${BLUEPRINT_STATUS[node.status]}，${node.progress}%`,
                        onDoubleClick: () => editNode(node),
                        onKeyDown: (event) => {
                          if (event.key === " " || event.key === "Enter") {
                            event.preventDefault();
                            focus(node);
                          }
                          if (event.key === "F2") editNode(node);
                        },
                      },
                      h("span", { className: "bp-pin", "aria-hidden": true }),
                      h("h3", null, node.title),
                      h("p", { className: "bp-body" }, node.body),
                      h(
                        "div",
                        { className: "bp-meta" },
                        h("span", null, BLUEPRINT_STATUS[node.status]),
                        h("span", null, node.owner),
                        h(
                          "span",
                          { style: { marginLeft: "auto" } },
                          `${node.progress}%`,
                        ),
                      ),
                      h("span", {
                        className: "bp-progress",
                        style: { width: `${node.progress}%` },
                        "aria-hidden": true,
                      }),
                    );
                  }),
                ),
                !board.nodes.length &&
                  h(
                    "div",
                    { className: "bp-empty" },
                    h("h2", null, board.title),
                    h("p", null, "从一个项目开始，逐层拆成行动。"),
                    button("添加第一个项目", () => newNode("project"), locked),
                  ),
                h(
                  "div",
                  { className: "bp-zoom", "aria-label": "画布缩放" },
                  button(icon("minus"), () => zoom(1 / 1.2), false, {
                    "aria-label": "缩小",
                  }),
                  h("span", null, `${Math.round(view.scale * 100)}%`),
                  button(icon("plus"), () => zoom(1.2), false, {
                    "aria-label": "放大",
                  }),
                  button(icon("fit"), fitCanvas, false, {
                    "aria-label": "适合窗口",
                  }),
                ),
              ),
        ),
        editorPanel,
        accessPanel,
      ),
      h(
        "div",
        { className: "bp-footer" },
        h(
          "span",
          null,
          board
            ? `${board.nodes.filter((node) => node.type === "project").length} 个项目 · ${board.nodes.filter((node) => node.type === "note").length} 张说明`
            : "社区共享蓝图",
        ),
        h("span", null, "单击聚焦 · 双击编辑 · 拖动排列 · F 适合窗口"),
        h("span", null, "默认只读 · 管理员授权编辑 · 手动刷新"),
      ),
    );
  }
  // Tabler IconLayoutBoard, MIT; see NOTICE.md.
  const image =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#626b66" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M9 9h12M15 9v12"/></svg>';
  ctx.pages.register({
    id: "main",
    title: "Blueprint",
    primary: true,
    placement: "topbar",
    layout: "workspace",
    icon: `data:image/svg+xml,${encodeURIComponent(image)}`,
    component: Blueprint,
  });
}

