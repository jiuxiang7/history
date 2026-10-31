(function (global) {
  'use strict';

const NODE = {
  width: 132,
  height: 168,
  portrait: 94,
  colGap: 24,
  top: 96,
  left: 158,
  right: 92,
  bottom: 88,
  labelX: 104,
};

// 同代两张卡片之间允许的最小间隙
const NODE_STEP = NODE.width + NODE.colGap;

/*
 * 纵向节奏：每一代的高度完全相同，不再逐层调节。
 * pitch = 卡片高 168 + 下沿到下一代的 52
 *   └ 52 = 下延伸线 33 + 分支线到子女的 19
 */
const ROW = {
  pitch: 220,
  stem: 33, // 卡片下沿 → 横向分支线：这一段是「向下延伸的线」
  dropMin: 19, // 分支线 → 子女卡片上沿的最小距离
};

function round(value) {
  return Math.round(value * 100) / 100;
}

function fmt(value) {
  return String(round(value));
}

function cleanPoints(points) {
  const result = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (!last || Math.abs(last.x - point.x) > 0.5 || Math.abs(last.y - point.y) > 0.5) {
      result.push(point);
    }
  }
  return result;
}

function straightPath(inputPoints) {
  const points = cleanPoints(inputPoints);
  if (points.length === 0) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${fmt(point.x)} ${fmt(point.y)}`)
    .join(' ');
}

function buildUnionMaps(unions) {
  const parentUnions = new Map();
  const childUnions = new Map();
  const push = (map, key, union) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(union);
  };
  unions.forEach((union) => {
    union.children.forEach((id) => push(parentUnions, id, union));
    union.parents.forEach((id) => push(childUnions, id, union));
  });
  return { parentUnions, childUnions };
}

function computeLayout(lineage, hiddenIds = new Set()) {
  const generations = [...lineage.generations].sort((a, b) => a.index - b.index);
  const visiblePeople = lineage.people.filter((person) => !hiddenIds.has(person.id));

  if (visiblePeople.length === 0) {
    return {
      empty: true,
      nodes: new Map(),
      unions: [],
      extraLinks: [],
      rows: [],
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 },
      generationIndex: new Map(),
      visiblePeople,
    };
  }

  const activeGenerations = generations.filter((generation) =>
    visiblePeople.some((person) => Number(person.generation) === Number(generation.index))
  );
  const generationIndex = new Map(
    activeGenerations.map((generation, index) => [generation.index, index])
  );

  const visibleIds = new Set(visiblePeople.map((person) => person.id));
  const visibleUnions = lineage.unions
    .map((union) => ({
      ...union,
      parents: union.parents.filter((id) => visibleIds.has(id)),
      children: union.children.filter((id) => visibleIds.has(id)),
    }))
    .filter((union) => union.parents.length > 0 && union.children.length > 0);

  const lineageIndex = new Map(lineage.people.map((person, index) => [person.id, index]));

  const rows = activeGenerations.map((generation, rowIndex) => ({
    generation,
    rowIndex,
    y: NODE.top + rowIndex * ROW.pitch,
    nodes: visiblePeople
      .filter((person) => Number(person.generation) === Number(generation.index))
      .sort((a, b) => (lineageIndex.get(a.id) ?? 0) - (lineageIndex.get(b.id) ?? 0)),
  }));

  const rowOfPerson = new Map();
  rows.forEach((row) => {
    row.nodes.forEach((person) => rowOfPerson.set(person.id, row.rowIndex));
  });

  const { parentUnions } = buildUnionMaps(visibleUnions);

  // 一对夫妻只保留一条血统主轴：有父母的一方作为主亲，另一方作为配偶节点。
  const primaryParentOf = new Map();
  const satelliteIds = new Set();

  visibleUnions.forEach((union) => {
    if (union.parents.length < 2) return;
    const anchor = union.parents.find((id) => (parentUnions.get(id) || []).length) || union.parents[0];
    union.parents.forEach((id) => {
      if (id !== anchor && !(parentUnions.get(id) || []).length) {
        satelliteIds.add(id);
      }
    });
  });

  visibleUnions.forEach((union) => {
    const anchor = union.parents.find((id) => !satelliteIds.has(id)) || union.parents[0];
    union.children.forEach((child) => {
      if (!primaryParentOf.has(child)) primaryParentOf.set(child, anchor);
    });
  });

  // 主亲树：每个孩子只挂在主亲名下；配偶不进入树宽计算。
  const childrenByParent = new Map();
  visibleUnions.forEach((union) => {
    const anchor = union.parents.find((id) => !satelliteIds.has(id)) || union.parents[0];
    union.children.forEach((child) => {
      if (primaryParentOf.get(child) !== anchor) return;
      if (!childrenByParent.has(anchor)) childrenByParent.set(anchor, []);
      const list = childrenByParent.get(anchor);
      if (!list.includes(child)) list.push(child);
    });
  });

  childrenByParent.forEach((children) => {
    children.sort((a, b) => (lineageIndex.get(a) ?? 0) - (lineageIndex.get(b) ?? 0));
  });

  const roots = visiblePeople.filter(
    (person) => !primaryParentOf.has(person.id) && !satelliteIds.has(person.id)
  );

  /*
   * 排布规则
   * 1. 单子相传时，孩子在父母的正下方：offset 恒为 0，连线是一条直线，不会拐弯。
   * 2. 多个子女逐个靠拢：相邻两棵子树只在这一对真正要相撞的那一层让开距离，
   *    其余兄弟不再被最宽的一对拖着走，所以同一代的后代尽量挤在一起。
   * 3. 每棵子树记录自己在各层的左右轮廓（相对根节点），父辈据此知道自己占多宽。
   */
  const shapeCache = new Map();
  const HALF = NODE.width / 2;

  // 相邻两棵子树在任意一层都不重叠时，所需的最小中心距
  function pairNeed(a, b, gapA, gapB) {
    let need = 0;
    const span = Math.max(gapA + a.right.length, gapB + b.left.length);
    for (let o = 0; o < span; o += 1) {
      // 轮廓按「相隔几行」索引；same o 在两棵子树里对应不同的局部下标
      const rightEdge = a.right[o - gapA];
      const leftEdge = b.left[o - gapB];
      if (rightEdge === undefined || leftEdge === undefined) continue;
      const require = rightEdge + leftEdge + NODE.colGap;
      if (require > need) need = require;
    }
    return need;
  }

  // 从左到右依次贴紧，再把整组挪回父节点正下方（首末子节点中点对齐）
  function packOffsets(subs, gaps) {
    if (subs.length <= 1) return subs.map(() => 0);
    const pos = [0];
    for (let i = 1; i < subs.length; i += 1) {
      pos.push(pos[i - 1] + pairNeed(subs[i - 1], subs[i], gaps[i - 1], gaps[i]));
    }
    const mid = (pos[0] + pos[pos.length - 1]) / 2;
    return pos.map((x) => x - mid);
  }

  function buildShape(id) {
    if (shapeCache.has(id)) return shapeCache.get(id);
    const children = childrenByParent.get(id) || [];

    if (!children.length) {
      const leaf = { offsets: [], left: [HALF], right: [HALF] };
      shapeCache.set(id, leaf);
      return leaf;
    }

    const subs = children.map((childId) => buildShape(childId));
    // 有的子代隔了不止一行（史载缺环），轮廓要按真实行差放置
    const gaps = children.map(
      (childId) => (rowOfPerson.get(childId) ?? 0) - (rowOfPerson.get(id) ?? 0)
    );
    // 独子：不挪位，保证「父 → 子」是一条竖直直线
    const offsets = packOffsets(subs, gaps);

    const left = [HALF];
    const right = [HALF];
    subs.forEach((sub, index) => {
      const gap = gaps[index];
      for (let d = 0; d < sub.left.length; d += 1) {
        if (sub.left[d] === undefined) continue;
        const o = gap + d;
        const lo = offsets[index] - sub.left[d];
        const hi = offsets[index] + sub.right[d];
        // 空洞（这一行这棵子树没人）保持 undefined，避免把别层的宽度算进来
        left[o] = left[o] === undefined ? -lo : Math.max(left[o], -lo);
        right[o] = right[o] === undefined ? hi : Math.max(right[o], hi);
      }
    });

    const shape = { offsets, left, right };
    shapeCache.set(id, shape);
    return shape;
  }

  const positions = new Map();

  function assign(id, x) {
    positions.set(id, x);
    const shape = shapeCache.get(id);
    if (!shape) return;
    const children = childrenByParent.get(id) || [];
    children.forEach((childId, index) => assign(childId, x + (shape.offsets[index] || 0)));
  }

  if (roots.length) {
    const rootShapes = roots.map((person) => buildShape(person.id));
    const offsets = packOffsets(
      rootShapes,
      rootShapes.map(() => 0)
    );
    roots.forEach((person, index) => assign(person.id, offsets[index]));
  }

  /*
   * 配偶（非血统主亲）贴着主亲放在同一代里。
   * 配偶不参与树宽计算，所以只能找空位；找不到就推到本代最外侧。
   */
  const occupancy = new Map();
  positions.forEach((x, id) => {
    const row = rowOfPerson.get(id);
    if (row === undefined) return;
    if (!occupancy.has(row)) occupancy.set(row, []);
    occupancy.get(row).push(x);
  });

  const satellitePlan = [];
  visibleUnions.forEach((union) => {
    if (union.parents.length < 2) return;
    const anchor = union.parents.find((id) => !satelliteIds.has(id)) || union.parents[0];
    union.parents.forEach((id) => {
      if (satelliteIds.has(id)) satellitePlan.push({ id, anchor });
    });
  });

  satellitePlan.forEach(({ id, anchor }) => {
    const anchorX = positions.get(anchor);
    if (!Number.isFinite(anchorX)) return;
    const row = rowOfPerson.get(id);
    const list = occupancy.get(row) || [];
    const free = (x) => list.every((other) => Math.abs(other - x) >= NODE_STEP - 0.5);

    let placed = null;
    for (const side of [1, -1]) {
      for (let slot = 1; slot <= 12 && placed === null; slot += 1) {
        const candidate = anchorX + side * NODE_STEP * slot;
        if (free(candidate)) placed = candidate;
      }
      if (placed !== null) break;
    }
    if (placed === null) placed = Math.max(...list, anchorX) + NODE_STEP;

    positions.set(id, placed);
    list.push(placed);
    occupancy.set(row, list);
  });

  const rawMin = Math.min(...visiblePeople.map((person) => positions.get(person.id) - HALF));
  const shift = NODE.left - rawMin;

  const nodes = new Map();
  rows.forEach((row) => {
    row.nodes.forEach((person) => {
      nodes.set(person.id, {
        id: person.id,
        person,
        x: positions.get(person.id) + shift,
        y: row.y,
        width: NODE.width,
        height: NODE.height,
        rowIndex: row.rowIndex,
      });
    });
  });

  rows.forEach((row) => {
    row.nodes = row.nodes.map((person) => nodes.get(person.id)).filter(Boolean);
  });

  const unionGeometry = visibleUnions.map((union) => {
    const parents = union.parents.map((id) => nodes.get(id)).filter(Boolean);
    const children = union.children.map((id) => nodes.get(id)).filter(Boolean);
    if (!parents.length || !children.length) return null;

    /*
     * 向下的连线只从「血统主亲」出发；配偶改在卡片中部横连一条婚配线。
     * 否则配偶会垂直落到总线上，看起来像子女从配偶那里垂下来。
     */
    const anchorNode = parents.find((node) => !satelliteIds.has(node.id)) || parents[0];
    const spouseNodes = parents.filter((node) => node.id !== anchorNode.id);

    const anchorX = anchorNode.x;
    const parentBottom = anchorNode.y + anchorNode.height;
    const childTop = Math.min(...children.map((node) => node.y));
    // 一组亲缘只有一条水平总线：主亲从上方垂到总线，子女从总线垂直落下。
    const busY = Math.min(parentBottom + ROW.stem, childTop - ROW.dropMin);
    const paths = [];

    // 单传：父与子同轴，直接画一条到底的竖线，不留任何折角
    const straightDown =
      spouseNodes.length === 0 &&
      children.length === 1 &&
      Math.abs(children[0].x - anchorX) < 0.5;

    if (straightDown) {
      paths.push({
        kind: 'stem',
        d: straightPath([
          { x: anchorX, y: parentBottom },
          { x: anchorX, y: children[0].y },
        ]),
      });
    } else {
      const xs = [...children.map((node) => node.x), anchorX];
      const busMin = Math.min(...xs);
      const busMax = Math.max(...xs);

      if (busMax - busMin > 0.5) {
        paths.push({
          kind: 'branch',
          d: straightPath([
            { x: busMin, y: busY },
            { x: busMax, y: busY },
          ]),
        });
      }
      paths.push({
        kind: 'stem',
        d: straightPath([
          { x: anchorX, y: parentBottom },
          { x: anchorX, y: busY },
        ]),
      });
      children.forEach((node) => {
        paths.push({
          kind: 'branch',
          d: straightPath([
            { x: node.x, y: busY },
            { x: node.x, y: node.y },
          ]),
        });
      });
    }

    spouseNodes.forEach((node) => {
      const midY = node.y + node.height / 2;
      const toRight = node.x > anchorX;
      paths.push({
        kind: 'tie',
        d: straightPath([
          { x: toRight ? anchorX + NODE.width / 2 : anchorX - NODE.width / 2, y: midY },
          { x: toRight ? node.x - NODE.width / 2 : node.x + NODE.width / 2, y: midY },
        ]),
      });
    });

    return {
      union,
      anchorX,
      busY,
      childBusY: busY,
      parents,
      children,
      paths,
      people: [...union.parents, ...union.children],
    };
  }).filter(Boolean);

  const maxX = Math.max(...[...nodes.values()].map((node) => node.x + node.width / 2));
  const minY = Math.min(...[...nodes.values()].map((node) => node.y));
  const maxY = Math.max(...[...nodes.values()].map((node) => node.y + node.height));

  const extraLinks = [];

  const bounds = {
    minX: 20,
    minY: Math.max(18, minY - 50),
    maxX: maxX + NODE.right,
    maxY: maxY + NODE.bottom,
  };
  bounds.width = bounds.maxX - bounds.minX;
  bounds.height = bounds.maxY - bounds.minY;

  return {
    empty: false,
    nodes,
    unions: unionGeometry,
    extraLinks,
    rows,
    bounds,
    generationIndex,
    visiblePeople,
  };
}

  global.LineageLayout = {
    NODE,
    computeLayout,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
