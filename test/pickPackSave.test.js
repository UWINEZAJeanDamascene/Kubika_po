const { makeCompatModel } = require('../utils/prismaCompat');

describe('PickPack mutable document save', () => {
  let capturedUpdate;
  let PickPack;

  beforeEach(() => {
    capturedUpdate = null;
    const row = {
      id: 'pick_pack_1',
      status: 'picking',
      lines: [{
        id: 'line_1',
        product: { _id: 'product_1', name: 'Widget' },
        qtyToPick: 1,
        qtyPicked: 1,
        status: 'picked',
      }],
    };
    const delegate = {
      name: 'PickPack',
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }) => {
        capturedUpdate = data;
        return {
          ...row,
          ...data,
          lines: data.lines?.create || row.lines,
        };
      }),
    };

    PickPack = makeCompatModel({
      delegate: () => delegate,
      delegateName: 'pickPack',
      mutable: true,
      fieldMap: { _id: { target: 'id', isId: true }, status: { target: 'status' } },
      toApi: (value) => value,
      translateCreate: (value) => ({
        lines: {
          create: value.lines.map((line) => ({
            id: line._id || line.id,
            productId: typeof line.product === 'object' ? line.product._id : line.product,
            qtyToPick: line.qtyToPick,
            qtyPicked: line.qtyPicked,
            status: line.status,
          })),
        },
      }),
      translateUpdate: ({ $set }) => ({ status: $set.status }),
      include: () => ({ lines: true }),
      beforeSave: async (doc) => {
        doc.lines = doc.lines.map((line) => ({
          ...line,
          product: typeof line.product === 'object' ? line.product._id : line.product,
        }));
      },
    });
  });

  test('does not rewrite unchanged lines during a status-only completion save', async () => {
    const pickPack = await PickPack.findById('pick_pack_1');
    pickPack.status = 'picked';

    await pickPack.save();

    expect(capturedUpdate).not.toHaveProperty('lines');
    expect(capturedUpdate.status).toBe('picked');
  });

  test('rewrites lines when a picked quantity changes', async () => {
    const pickPack = await PickPack.findById('pick_pack_1');
    pickPack.lines[0].qtyPicked = 0.5;

    await pickPack.save();

    expect(capturedUpdate.lines.create[0].qtyPicked).toBe(0.5);
  });
});