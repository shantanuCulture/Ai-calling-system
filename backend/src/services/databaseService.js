const { v4: uuidv4 } = require('uuid');
const db = require('../database/mockDb');
const logger = require('../utils/logger');

class DatabaseService {
  // ── Tours ──────────────────────────────────────────────────────────────────

  getTourByDestination(destination) {
    if (!destination) return null;
    return db.tours.find((t) => t.destination.toLowerCase() === destination.toLowerCase()) || null;
  }

  getAllTours() {
    return db.tours;
  }

  // ── Agents ─────────────────────────────────────────────────────────────────

  getAgentById(agentId) {
    return db.agents.find((a) => a.id === agentId) || null;
  }

  getAvailableAgent(department = 'sales') {
    return db.agents.find((a) => a.department === department && a.available) || null;
  }

  getAllAgents() {
    return db.agents;
  }

  addAgent(data) {
    const agent = { id: uuidv4(), ...data, createdAt: new Date().toISOString() };
    db.agents.push(agent);
    logger.info(`Agent added: ${agent.id} (${agent.name})`);
    return agent;
  }

  updateAgent(agentId, data) {
    const index = db.agents.findIndex((a) => a.id === agentId);
    if (index === -1) return null;
    db.agents[index] = { ...db.agents[index], ...data, updatedAt: new Date().toISOString() };
    return db.agents[index];
  }

  deleteAgent(agentId) {
    const index = db.agents.findIndex((a) => a.id === agentId);
    if (index === -1) return false;
    db.agents.splice(index, 1);
    return true;
  }

  // ── Leads ──────────────────────────────────────────────────────────────────

  saveLead(data) {
    const lead = { id: uuidv4(), ...data, createdAt: new Date().toISOString() };
    db.leads.push(lead);
    logger.info(`Lead saved: ${lead.id}`);
    return lead;
  }

  getAllLeads() {
    return db.leads;
  }

  // ── Call Logs ──────────────────────────────────────────────────────────────

  saveCallLog(data) {
    const log = { id: uuidv4(), ...data, timestamp: new Date().toISOString() };
    db.callLogs.push(log);
    return log;
  }

  updateCallLog(callSid, data) {
    const index = db.callLogs.findIndex((l) => l.callSid === callSid);
    if (index === -1) return null;
    db.callLogs[index] = { ...db.callLogs[index], ...data };
    return db.callLogs[index];
  }

  getAllCallLogs() {
    return [...db.callLogs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }
}

module.exports = new DatabaseService();
