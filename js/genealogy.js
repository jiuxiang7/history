(function (global) {
  'use strict';

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function cnNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n < 10) return CN_DIGITS[n];
  if (n < 20) return n === 10 ? '十' : `十${CN_DIGITS[n % 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${CN_DIGITS[tens]}十${ones ? CN_DIGITS[ones] : ''}`;
  }
  return String(n);
}

function validateLineage(data, source = '谱系') {
  const errors = [];
  if (!data || typeof data !== 'object') {
    throw new Error(`${source}：文件内容不是有效的 JSON 对象。`);
  }
  if (!Array.isArray(data.people) || data.people.length === 0) {
    errors.push('缺少 people 数组或人物为空');
  }
  if (!Array.isArray(data.generations) || data.generations.length === 0) {
    errors.push('缺少 generations 数组或世代为空');
  }

  const generationSet = new Set(
    (Array.isArray(data.generations) ? data.generations : [])
      .map((g) => Number(g.index))
      .filter(Number.isFinite)
  );
  const ids = new Set();
  const people = Array.isArray(data.people) ? data.people : [];

  people.forEach((person, index) => {
    const where = `人物第 ${index + 1} 条`;
    if (!person || typeof person !== 'object') {
      errors.push(`${where}不是对象`);
      return;
    }
    if (!person.id || typeof person.id !== 'string') {
      errors.push(`${where}缺少字符串 id`);
    } else if (ids.has(person.id)) {
      errors.push(`人物 id 重复：${person.id}`);
    } else {
      ids.add(person.id);
    }
    if (!person.name || typeof person.name !== 'string') {
      errors.push(`${where}缺少 name`);
    }
    if (!generationSet.has(Number(person.generation))) {
      errors.push(`${person.id || where} 的 generation 不在 generations 中`);
    }
    if (person.honor && !['emperor', 'other'].includes(person.honor)) {
      errors.push(`${person.id || where} 的 honor 只能是 emperor 或 other`);
    }
    if (person.indexed !== undefined && typeof person.indexed !== 'boolean') {
      errors.push(`${person.id || where} 的 indexed 只能是 true 或 false`);
    }
    if (person.title !== undefined && typeof person.title !== 'string') {
      errors.push(`${person.id || where} 的 title 只能是字符串`);
    }
  });

  const unionIds = new Set();
  const unions = Array.isArray(data.unions) ? data.unions : [];

  unions.forEach((union, index) => {
    const where = `关系第 ${index + 1} 条${union?.id ? `（${union.id}）` : ''}`;
    if (!union || typeof union !== 'object') {
      errors.push(`${where}不是对象`);
      return;
    }
    if (union.id) {
      if (unionIds.has(union.id)) errors.push(`关系 id 重复：${union.id}`);
      unionIds.add(union.id);
    }
    if (!Array.isArray(union.parents) || union.parents.length === 0) {
      errors.push(`${where}缺少 parents`);
    }
    if (!Array.isArray(union.children) || union.children.length === 0) {
      errors.push(`${where}缺少 children`);
    }
    const parents = Array.isArray(union.parents) ? union.parents : [];
    const children = Array.isArray(union.children) ? union.children : [];
    [...parents, ...children].forEach((id) => {
      if (!ids.has(id)) errors.push(`${where}引用了不存在的人物：${id}`);
    });
    if (parents.length && children.length) {
      const parentGenerations = parents
        .filter((id) => ids.has(id))
        .map((id) => Number(people.find((p) => p.id === id)?.generation));
      const childGenerations = children
        .filter((id) => ids.has(id))
        .map((id) => Number(people.find((p) => p.id === id)?.generation));
      if (parentGenerations.length && childGenerations.length) {
        const maxParent = Math.max(...parentGenerations);
        const minChild = Math.min(...childGenerations);
        if (minChild <= maxParent) {
          errors.push(`${where}的子代没有晚于亲代`);
        }
      }
    }
  });

  const extraLinks = Array.isArray(data.extraLinks) ? data.extraLinks : [];
  extraLinks.forEach((link, index) => {
    if (!link || !ids.has(link.from) || !ids.has(link.to)) {
      errors.push(`特殊关系第 ${index + 1} 条引用了不存在的人物`);
    }
  });

  if (errors.length) {
    const detail = errors.slice(0, 8).join('；');
    const more = errors.length > 8 ? `；另有 ${errors.length - 8} 处` : '';
    throw new Error(`${source} 数据有误：${detail}${more}`);
  }

  return data;
}

function buildIndex(lineage) {
  const byId = new Map();
  const order = new Map();
  lineage.people.forEach((person, index) => {
    byId.set(person.id, person);
    order.set(person.id, index);
  });

  const parentsOf = new Map();
  const childUnionsOf = new Map();
  const unionsByPerson = new Map();
  const spouseIds = new Map();

  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };

  lineage.unions.forEach((union) => {
    union.children.forEach((id) => push(parentsOf, id, union));
    union.parents.forEach((id) => push(childUnionsOf, id, union));
    const involved = new Set([...union.parents, ...union.children]);
    involved.forEach((id) => {
      if (!unionsByPerson.has(id)) unionsByPerson.set(id, new Set());
      unionsByPerson.get(id).add(union);
    });
    if (union.parents.length > 1) {
      union.parents.forEach((id) => {
        if (!spouseIds.has(id)) spouseIds.set(id, new Set());
        union.parents.forEach((other) => {
          if (other !== id) spouseIds.get(id).add(other);
        });
      });
    }
  });

  return {
    lineage,
    byId,
    order,
    parentsOf,
    childUnionsOf,
    unionsByPerson,
    spouseIds,
    people: lineage.people,
    unions: lineage.unions,
    extraLinks: lineage.extraLinks || [],
    generations: [...lineage.generations].sort((a, b) => a.index - b.index),
    generationIndex: new Map(
      [...lineage.generations]
        .sort((a, b) => a.index - b.index)
        .map((generation, index) => [generation.index, index])
    ),
  };
}

function getDescendants(index, id) {
  const found = new Set();
  const queue = [id];
  while (queue.length) {
    const current = queue.shift();
    const unions = index.childUnionsOf.get(current) || [];
    for (const union of unions) {
      for (const childId of union.children) {
        if (childId === id || found.has(childId)) continue;
        found.add(childId);
        queue.push(childId);
      }
    }
  }
  return found;
}

function getAncestors(index, id) {
  const found = new Set();
  const queue = [id];
  while (queue.length) {
    const current = queue.shift();
    const unions = index.parentsOf.get(current) || [];
    for (const union of unions) {
      for (const parentId of union.parents) {
        if (parentId === id || found.has(parentId)) continue;
        found.add(parentId);
        queue.push(parentId);
      }
    }
  }
  return found;
}

function getKeyPeople(index) {
  return index.people
    .filter((person) => person.importance === 'key')
    .sort((a, b) => a.generation - b.generation || index.order.get(a.id) - index.order.get(b.id));
}

function getRelations(index, id) {
  const parentGroups = (index.parentsOf.get(id) || []).map((union) => ({
    union,
    ids: union.parents,
  }));
  const childGroups = (index.childUnionsOf.get(id) || []).map((union) => ({
    union,
    ids: union.children,
  }));
  const spouseIds = [...(index.spouseIds.get(id) || [])];
  const extraLinks = index.extraLinks
    .filter((link) => link.from === id || link.to === id)
    .map((link) => ({
      ...link,
      direction: link.from === id ? 'out' : 'in',
      otherId: link.from === id ? link.to : link.from,
    }));
  return { parentGroups, childGroups, spouseIds, extraLinks };
}

function countLineage(data) {
  return {
    people: data.people.length,
    generations: data.generations.length,
    unions: data.unions.length,
  };
}

  global.Genealogy = {
    cnNumber,
    validateLineage,
    buildIndex,
    getDescendants,
    getAncestors,
    getKeyPeople,
    getRelations,
    countLineage,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
