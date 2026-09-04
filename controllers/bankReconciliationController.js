const service = require("../services/bankReconciliationService");

function companyId(req) {
  return req.company?._id || req.user?.company || req.user?.companyId || req.user?.company_id;
}

function userId(req) {
  return req.user?._id || req.user?.id || req.user;
}

function sendError(res, error) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || "Bank reconciliation request failed.",
  });
}

exports.createSession = async (req, res) => {
  try {
    const session = await service.createSession(companyId(req), userId(req), req.body);
    res.status(201).json({ success: true, data: session });
  } catch (error) {
    sendError(res, error);
  }
};

exports.listSessions = async (req, res) => {
  try {
    const sessions = await service.listSessions(companyId(req), req.query);
    res.json({ success: true, ...sessions });
  } catch (error) {
    sendError(res, error);
  }
};

exports.getSession = async (req, res) => {
  try {
    const [session, summary] = await Promise.all([
      service.getSession(companyId(req), req.params.id),
      service.calculateSummary(companyId(req), req.params.id),
    ]);
    res.json({ success: true, data: { session, summary } });
  } catch (error) {
    sendError(res, error);
  }
};

exports.completeSession = async (req, res) => {
  try {
    const session = await service.complete(companyId(req), userId(req), req.params.id);
    res.json({ success: true, data: session });
  } catch (error) {
    sendError(res, error);
  }
};

exports.lockSession = async (req, res) => {
  try {
    const session = await service.lock(companyId(req), req.params.id);
    res.json({ success: true, data: session });
  } catch (error) {
    sendError(res, error);
  }
};

exports.importTransactions = async (req, res) => {
  try {
    const result = await service.importStatement(companyId(req), req.params.id, req.file.buffer, "csv");
    res.status(result.errors.length ? 207 : 201).json({ success: result.errors.length === 0, data: result });
  } catch (error) {
    sendError(res, error);
  }
};

exports.addTransaction = async (req, res) => {
  try {
    const tx = await service.addStatementTransaction(companyId(req), req.params.id, req.body, "manual");
    res.status(201).json({ success: true, data: tx });
  } catch (error) {
    sendError(res, error);
  }
};

exports.listTransactions = async (req, res) => {
  try {
    const transactions = await service.listStatementTransactions(companyId(req), req.params.id, req.query);
    res.json({ success: true, data: transactions.data, pagination: transactions.pagination });
  } catch (error) {
    sendError(res, error);
  }
};

exports.deleteTransaction = async (req, res) => {
  try {
    await service.deleteStatementTransaction(companyId(req), req.params.id, req.params.txId);
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
};

exports.listBookTransactions = async (req, res) => {
  try {
    const transactions = await service.listBookTransactions(companyId(req), req.params.id, req.query);
    res.json({ success: true, data: transactions.data, pagination: transactions.pagination });
  } catch (error) {
    sendError(res, error);
  }
};

exports.match = async (req, res) => {
  try {
    const match = await service.createMatch(companyId(req), userId(req), req.params.id, req.body, "manual");
    res.status(201).json({ success: true, data: match });
  } catch (error) {
    sendError(res, error);
  }
};

exports.autoMatch = async (req, res) => {
  try {
    const result = await service.autoMatch(companyId(req), userId(req), req.params.id, Number(req.body?.toleranceDays || 2));
    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
};

exports.unmatch = async (req, res) => {
  try {
    await service.deleteMatch(companyId(req), req.params.matchId);
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
};

exports.summary = async (req, res) => {
  try {
    const summary = await service.calculateSummary(companyId(req), req.params.id);
    res.json({ success: true, data: summary });
  } catch (error) {
    sendError(res, error);
  }
};
