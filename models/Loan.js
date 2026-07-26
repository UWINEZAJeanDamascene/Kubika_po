/**
 * Loan / Liability — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  loanToApi,
  loanTranslateCreate,
  loanTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  loanNumber: { target: 'loanNumber' },
  name: { target: 'name' },
  loanType: { target: 'loanType' },
  type: { target: 'type' },
  status: { target: 'status' },
  startDate: { target: 'startDate' },
  originalAmount: { target: 'originalAmount' },
  outstandingBalance: { target: 'outstandingBalance' },
  amountPaid: { target: 'amountPaid' },
  liabilityAccountId: { target: 'liabilityAccountId' },
  interestExpenseAccountId: { target: 'interestExpenseAccountId' },
  relatedPartyId: { target: 'relatedPartyId', isId: true },
};

module.exports = buildTenantModel({
  name: 'Loan',
  collection: 'loans',
  delegateName: 'loan',
  fieldMap: FIELD_MAP,
  toApi: loanToApi,
  translateCreate: loanTranslateCreate,
  translateUpdate: loanTranslateUpdate,
  mutable: true,
});
