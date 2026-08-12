'use strict';

jest.mock('../../../models/AIActionProposal', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../../services/AuditLogService', () => ({
  log: jest.fn().mockResolvedValue(null),
}));

const AIActionProposal = require('../../../models/AIActionProposal');
const service = require('../../../services/aiActionProposalService');

describe('AI Action Proposal Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('gets proposals with company scope and proposal id', async () => {
    AIActionProposal.findOne.mockResolvedValue(null);

    const result = await service.getProposal('company_a', 'proposal_1');

    expect(result).toBeNull();
    expect(AIActionProposal.findOne).toHaveBeenCalledWith({
      company: 'company_a',
      proposalId: 'proposal_1',
    });
  });

  test('execution refuses proposals that are not approved', async () => {
    AIActionProposal.findOne.mockResolvedValue({
      toObject: () => ({
        proposalId: 'proposal_1',
        company: 'company_a',
        createdBy: 'user_1',
        type: 'purchase_order_draft',
        status: 'rejected',
        payload: {},
        evidenceFactIds: [],
        sourceRecommendationIds: [],
        sourceFindingIds: [],
        riskLevel: 'medium',
        approvalRequiredByRole: ['admin'],
      }),
    });

    await expect(service.executeProposal('company_a', 'proposal_1', {
      _id: 'user_admin',
      permissions: ['*'],
      roles: [{ name: 'admin', permissions: ['*'] }],
    })).rejects.toThrow('must be approved');

    expect(AIActionProposal.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
