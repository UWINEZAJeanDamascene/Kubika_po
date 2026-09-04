'use strict';

const { buildGlobalModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  createdBy: { target: 'createdBy' },
  isActive: { target: 'isActive' },
  order: { target: 'order' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function testimonialToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    name: row.name,
    role: row.role,
    company: row.company,
    avatar: row.avatar ?? null,
    content: row.content,
    rating: Number(row.rating ?? 5),
    isActive: row.isActive,
    order: row.order,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translateCreate(data = {}) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    name: data.name,
    role: data.role,
    company: data.company,
    avatar: data.avatar ?? null,
    content: data.content,
    rating: data.rating ?? 5,
    isActive: data.isActive ?? true,
    order: data.order ?? 0,
    createdBy: data.createdBy ? toIdString(data.createdBy) : null,
  };
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$unset;
  const data = {};
  for (const field of ['name', 'role', 'company', 'avatar', 'content', 'rating', 'isActive', 'order']) {
    if (source[field] !== undefined) data[field] = source[field];
  }
  if (source.createdBy !== undefined) data.createdBy = source.createdBy ? toIdString(source.createdBy) : null;
  return data;
}

module.exports = buildGlobalModel({
  name: 'Testimonial',
  collection: 'testimonials',
  delegateName: 'testimonial',
  fieldMap: FIELD_MAP,
  toApi: testimonialToApi,
  translateCreate,
  translateUpdate,
  mutable: true,
});
