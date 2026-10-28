import { Router } from 'express';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

// Fix for esbuild CJS bundle warning
const _filename = typeof import.meta !== 'undefined' && import.meta.url ? fileURLToPath(import.meta.url) : __filename;
const _dirname = typeof import.meta !== 'undefined' && import.meta.url ? path.dirname(_filename) : __dirname;

export const autRouter = Router();

const DB_FILE = path.join(_dirname, 'db.json');

const getDb = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
const saveDb = (data: any) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// Seed data: 3 fixed users plus 15 generated ones. Generated roles are
// randomized on purpose so suites must derive role counts from the API at
// runtime, while statuses stay deterministic (inactive for IDs 4, 7, 10, 13, 16).
function buildSeedUsers(): any[] {
  const now = new Date().toISOString();
  return [
    { id: 1, name: 'Alice Smith', email: 'alice@example.com', role: 'admin', status: 'active', departmentPath: ['development', 'frontend', 'react'], permissions: ['view_reports', 'manage_users'], createdAt: now, updatedAt: now },
    { id: 2, name: 'Bob Jones', email: 'bob@example.com', role: 'editor', status: 'inactive', departmentPath: ['design', 'ui'], permissions: ['view_reports'], createdAt: now, updatedAt: now },
    { id: 3, name: 'Charlie Brown', email: 'charlie@example.com', role: 'viewer', status: 'active', departmentPath: ['development', 'backend', 'node'], permissions: [], createdAt: now, updatedAt: now },
    ...Array.from({ length: 15 }).map((_, i) => ({
      id: i + 4,
      name: `User ${i + 4}`,
      email: `user${i + 4}@example.com`,
      role: ['viewer', 'editor', 'admin'][Math.floor(Math.random() * 3)],
      status: i % 3 === 0 ? 'inactive' : 'active',
      departmentPath: i % 2 === 0 ? ['development', 'frontend'] : ['design', 'ux'],
      permissions: ['view_reports'],
      createdAt: new Date(Date.now() - Math.random() * 1000000000).toISOString(),
      updatedAt: new Date(Date.now() - Math.random() * 500000000).toISOString()
    }))
  ];
}

// Initialize DB if not exists
if (!fs.existsSync(DB_FILE)) {
  saveDb({ users: buildSeedUsers() });
}

// Auth Flow
autRouter.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin123') {
    return res.json({
      success: true,
      token: 'fake-jwt-token-12345',
      user: { id: 1, name: 'Admin', username: 'admin' }
    });
  }
  return res.status(401).json({ success: false, error: 'Invalid credentials' });
});

autRouter.get('/profile', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== 'fake-jwt-token-12345') {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  res.json({ success: true, data: { id: 1, name: 'Admin', role: 'super-admin' } });
});

// User CRUD
autRouter.get('/users', (req, res) => {
  const { name, role, status, search, page = '1', limit = '10', sortBy = 'updatedAt', sortOrder = 'desc' } = req.query;
  const db = getDb();
  let filteredUsers = [...db.users];

  if (name) {
    const n = String(name).toLowerCase();
    filteredUsers = filteredUsers.filter(u => u.name.toLowerCase().includes(n));
  }
  if (role) {
    filteredUsers = filteredUsers.filter(u => u.role === role);
  }
  if (status) {
    filteredUsers = filteredUsers.filter(u => u.status === status);
  }
  if (search) {
    const s = String(search).toLowerCase();
    filteredUsers = filteredUsers.filter(u => u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s));
  }

  // Sorting
  filteredUsers.sort((a, b) => {
    let fieldA = a[String(sortBy)];
    let fieldB = b[String(sortBy)];

    if (fieldA == null) return 1;
    if (fieldB == null) return -1;

    if (typeof fieldA === 'string') {
      fieldA = fieldA.toLowerCase();
      fieldB = fieldB.toLowerCase();
    }

    if (fieldA < fieldB) return sortOrder === 'asc' ? -1 : 1;
    if (fieldA > fieldB) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  const parsedPage = parseInt(String(page), 10);
  const parsedLimit = parseInt(String(limit), 10);
  const startIndex = (parsedPage - 1) * parsedLimit;

  const paginatedUsers = filteredUsers.slice(startIndex, startIndex + parsedLimit);

  res.json({
    success: true,
    data: paginatedUsers,
    total: filteredUsers.length,
    page: parsedPage,
    limit: parsedLimit
  });
});

autRouter.get('/users/:id', (req, res) => {
  const db = getDb();
  const user = db.users.find((u: any) => u.id === parseInt(req.params.id));
  if (!user) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: user });
});

autRouter.post('/users', (req, res) => {
  const db = getDb();
  const { name, email, ...rest } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ success: false, error: 'Name is required and must be a string' });
  }
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ success: false, error: 'Email is required and must be a string' });
  }

  const nextId = db.users.length > 0 ? Math.max(...db.users.map((u: any) => u.id)) + 1 : 1;
  const now = new Date().toISOString();
  const newUser = {
    id: nextId,
    name,
    email,
    ...rest,
    role: rest.role || 'viewer',
    status: rest.status || 'inactive',
    createdAt: now,
    updatedAt: now
  };
  db.users.push(newUser);
  saveDb(db);
  res.status(201).json({ success: true, data: newUser });
});

autRouter.patch('/users/:id', (req, res) => {
  const db = getDb();
  const index = db.users.findIndex((u: any) => u.id === parseInt(req.params.id));
  if (index === -1) return res.status(404).json({ success: false, error: 'Not found' });

  db.users[index] = {
    ...db.users[index],
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  saveDb(db);
  res.json({ success: true, data: db.users[index] });
});

autRouter.put('/users/:id', (req, res) => {
  const db = getDb();
  const index = db.users.findIndex((u: any) => u.id === parseInt(req.params.id));
  if (index === -1) return res.status(404).json({ success: false, error: 'Not found' });

  db.users[index] = {
    ...db.users[index],
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  saveDb(db);
  res.json({ success: true, data: db.users[index] });
});

autRouter.delete('/users/:id', (req, res) => {
  const db = getDb();
  const index = db.users.findIndex((u: any) => u.id === parseInt(req.params.id));
  if (index === -1) return res.status(404).json({ success: false, error: 'Not found' });

  const deletedUser = db.users[index];
  db.users = db.users.filter((u: any) => u.id !== parseInt(req.params.id));
  saveDb(db);
  res.json({ success: true, data: deletedUser });
});

autRouter.post('/users/batch-update', (req, res) => {
  const db = getDb();
  const { ids, data } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ success: false, error: 'IDs must be an array' });

  db.users = db.users.map((u: any) => {
    if (ids.includes(u.id)) {
      return { ...u, ...data };
    }
    return u;
  });

  saveDb(db);
  res.json({ success: true });
});

autRouter.post('/users/:id/reset-password', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const index = db.users.findIndex((u: any) => u.id === id);
  if (index === -1) return res.status(404).json({ success: false, error: 'User not found' });

  db.users[index].updatedAt = new Date().toISOString();
  db.users[index].lastPasswordResetSentAt = new Date().toISOString();

  saveDb(db);
  res.json({ success: true });
});

autRouter.post('/users/batch-delete', (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ success: false, error: 'IDs must be an array' });

  db.users = db.users.filter((u: any) => !ids.includes(u.id));
  saveDb(db);
  res.json({ success: true });
});

// Test Data Reset
// Rewrites db.json with a fresh seed so suites can start from a known state
// without deleting the file and restarting the server. Unauthenticated like
// the fault endpoints — it is demo test infrastructure.
autRouter.post('/test/reset', (req, res) => {
  const seed = buildSeedUsers();
  saveDb({ users: seed });
  res.json({
    success: true,
    message: 'Database reset to seed state',
    data: { userCount: seed.length }
  });
});

// Fault Injection
autRouter.get('/fault/timeout', (req, res) => {
  setTimeout(() => {
    res.json({ success: true, message: 'Delayed response' });
  }, 5000);
});

autRouter.get('/fault/simulate-500', (req, res) => {
  if (Math.random() > 0.5) {
    res.status(500).json({ success: false, error: 'Simulated strict internal failure' });
  } else {
    res.json({ success: true, message: 'Lucky you, it worked this time' });
  }
});

autRouter.get('/fault/xml-content', (req, res) => {
  const xmlResponse = `
    <response>
      <success>true</success>
      <message>This is returned in XML format</message>
    </response>
  `;
  res.set('Content-Type', 'application/xml');
  res.send(xmlResponse.trim());
});

autRouter.get('/dashboard/stats', (req, res) => {
  const db = getDb();
  res.json({
    success: true,
    data: {
      totalUsers: db.users.length,
      activeUsers: db.users.filter((u: any) => u.status === 'active').length,
      recentRegistrations: db.users.slice(-5)
    }
  });
});

autRouter.get('/reports', (req, res) => {
  const db = getDb();
  const totalUsers = db.users.length;
  const activeUsers = db.users.filter((u: any) => u.status === 'active').length;

  const roleDistribution = [
    { name: 'admin', value: db.users.filter((u: any) => u.role === 'admin').length },
    { name: 'editor', value: db.users.filter((u: any) => u.role === 'editor').length },
    { name: 'viewer', value: db.users.filter((u: any) => u.role === 'viewer').length },
  ];

  const departmentCount: any = {};
  db.users.forEach((u: any) => {
    const dept = u.departmentPath && u.departmentPath.length > 0 ? u.departmentPath[0] : 'Unassigned';
    departmentCount[dept] = (departmentCount[dept] || 0) + 1;
  });

  const departmentDistribution = Object.keys(departmentCount).map(k => ({
    name: k.charAt(0).toUpperCase() + k.slice(1),
    count: departmentCount[k]
  }));

  res.json({
    success: true,
    data: {
      totalUsers,
      activeUsers,
      roleDistribution,
      departmentDistribution
    }
  });
});
