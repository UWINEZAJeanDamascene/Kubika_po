const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  tillSessionToApi,
  tillSessionTranslateCreate,
  tillSessionTranslateUpdate,
} = require('../utils/tillMappers');

describe('Till session mappers', () => {
  test('toApi emits the legacy shape with numeric cash amounts', () => {
    const api = tillSessionToApi({
      id: '507f1f77bcf86cd799439011',
      companyId: '507f1f77bcf86cd799439021',
      openedById: '507f1f77bcf86cd799439031',
      status: 'open',
      openingFloat: { toString: () => '25000.00' },
      closingCount: null,
      openedAt: new Date('2026-07-25T08:00:00Z'),
      closedAt: null,
      createdAt: new Date('2026-07-25T08:00:00Z'),
      updatedAt: new Date('2026-07-25T08:00:00Z'),
    });
    expect(api._id).toBe('507f1f77bcf86cd799439011');
    expect(api.company).toBe('507f1f77bcf86cd799439021');
    expect(api.openedBy).toBe('507f1f77bcf86cd799439031');
    expect(api.openingFloat).toBe(25000);
    expect(api.closingCount).toBeNull();
    expect(api.status).toBe('open');
  });

  test('translateCreate maps company/openedBy refs and defaults the status', () => {
    const data = tillSessionTranslateCreate({
      company: '507f1f77bcf86cd799439021',
      openedBy: '507f1f77bcf86cd799439031',
      openingFloat: 1500,
    });
    expect(data.id).toMatch(/^[0-9a-f]{24}$/);
    expect(data.companyId).toBe('507f1f77bcf86cd799439021');
    expect(data.openedById).toBe('507f1f77bcf86cd799439031');
    expect(data.openingFloat).toBe(1500);
    expect(data.status).toBe('open');
  });

  test('translateUpdate unwraps $set and only emits the closing fields', () => {
    const closedAt = new Date('2026-07-25T17:00:00Z');
    const data = tillSessionTranslateUpdate({ $set: { status: 'closed', closedAt, closingCount: '31500' } });
    expect(data).toEqual({ status: 'closed', closedAt, closingCount: 31500 });
  });
});
