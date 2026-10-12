const {
  createSale,
  addPayment,
  openDrawer,
  closeDrawer,
  getDrawer,
} = require('../controllers/posController');

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('Retired /api/pos checkout and drawer paths', () => {
  test('createSale returns 410 and points callers to sales-legacy', async () => {
    const res = mockRes();
    await createSale({}, res);
    expect(res.statusCode).toBe(410);
    expect(res.body.code).toBe('POS_CHECKOUT_PATH_RETIRED');
    expect(res.body.use).toBe('/api/sales-legacy/direct-sale');
    expect(res.headers.Deprecation).toBe('true');
    expect(res.headers.Link).toContain('/api/sales-legacy/direct-sale');
  });

  test('addPayment returns 410 and does not record tender', async () => {
    const res = mockRes();
    await addPayment({ params: { id: '507f1f77bcf86cd799439011' }, body: { amount: 1000 } }, res);
    expect(res.statusCode).toBe(410);
    expect(res.body.code).toBe('POS_PAYMENT_PATH_RETIRED');
  });

  test('drawer endpoints return 410 and point callers to tills', async () => {
    for (const handler of [openDrawer, closeDrawer, getDrawer]) {
      const res = mockRes();
      await handler({ params: { drawerId: 'main' }, body: {} }, res);
      expect(res.statusCode).toBe(410);
      expect(res.body.code).toBe('POS_DRAWER_PATH_RETIRED');
      expect(String(res.body.use)).toMatch(/\/api\/tills\//);
    }
  });
});
