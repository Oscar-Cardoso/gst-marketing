import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import session from 'express-session';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import bcryptjs from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

// Session
app.use(session({
  secret: 'gst-marketing-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true }
}));

// Multer para upload de playbooks
const upload = multer({ 
  dest: 'public/uploads/playbooks',
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// Arquivos de dados
const dataDir = 'data';
const ensureDataDir = () => !fs.existsSync(dataDir) && fs.mkdirSync(dataDir, { recursive: true });

const getLeads = () => {
  ensureDataDir();
  const file = join(dataDir, 'leads.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
};

const saveLead = (lead) => {
  ensureDataDir();
  const leads = getLeads();
  leads.push({ ...lead, id: uuid(), createdAt: new Date().toISOString() });
  fs.writeFileSync(join(dataDir, 'leads.json'), JSON.stringify(leads, null, 2));
};

const getPropostas = () => {
  ensureDataDir();
  const file = join(dataDir, 'propostas.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
};

const updateProposta = (id, updates) => {
  ensureDataDir();
  let propostas = getPropostas();
  propostas = propostas.map(p => p.id === id ? { ...p, ...updates } : p);
  fs.writeFileSync(join(dataDir, 'propostas.json'), JSON.stringify(propostas, null, 2));
};

const getPlaybooks = () => {
  ensureDataDir();
  const file = join(dataDir, 'playbooks.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
};

const savePlaybook = (playbook) => {
  ensureDataDir();
  const playbooks = getPlaybooks();
  playbooks.push({ ...playbook, id: uuid(), uploadedAt: new Date().toISOString() });
  fs.writeFileSync(join(dataDir, 'playbooks.json'), JSON.stringify(playbooks, null, 2));
};

// Autenticação
const ADMIN_PASSWORD = await bcryptjs.hash('T@ubate6', 10);

const isAdmin = (req, res, next) => {
  if (req.session.admin) {
    next();
  } else {
    res.status(401).json({ error: 'Não autenticado' });
  }
};

// ========== ROTAS PÚBLICAS ==========

// Site principal (HTML)
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/propostas', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'propostas', 'index.html'));
});

// Form de captação
app.post('/api/leads', async (req, res) => {
  try {
    const { nome, whatsapp, loja, faturamento, desafio } = req.body;
    
    if (!nome || !whatsapp || !loja) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    saveLead({ nome, whatsapp, loja, faturamento, desafio, status: 'Novo' });
    res.json({ success: true, message: 'Lead captado com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ROTAS ADMIN ==========

// Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { senha } = req.body;
    const match = await bcryptjs.compare(senha, ADMIN_PASSWORD);
    
    if (match) {
      req.session.admin = true;
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Senha incorreta' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Logout
app.post('/api/admin/logout', (req, res) => {
  req.session.admin = false;
  res.json({ success: true });
});

// Dashboard
app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});

// Leads
app.get('/api/admin/leads', isAdmin, (req, res) => {
  res.json(getLeads());
});

// Propostas
app.get('/api/admin/propostas', isAdmin, (req, res) => {
  res.json(getPropostas());
});

app.post('/api/admin/propostas', isAdmin, (req, res) => {
  try {
    const { titulo, cliente, valor } = req.body;
    const propostas = getPropostas();
    propostas.push({
      id: uuid(),
      titulo,
      cliente,
      valor,
      status: 'Enviada',
      notas: '',
      createdAt: new Date().toISOString()
    });
    fs.writeFileSync(join(dataDir, 'propostas.json'), JSON.stringify(propostas, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/admin/propostas/:id', isAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { status, notas } = req.body;
    updateProposta(id, { status, notas });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Playbooks
app.get('/api/admin/playbooks', isAdmin, (req, res) => {
  res.json(getPlaybooks());
});

app.post('/api/admin/playbooks', isAdmin, upload.single('file'), (req, res) => {
  try {
    const { titulo, categoria, descricao } = req.body;
    
    if (!titulo || !categoria || !req.file) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    savePlaybook({
      titulo,
      categoria,
      descricao,
      arquivo: req.file.filename,
      tamanho: req.file.size
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/playbooks/:id', isAdmin, (req, res) => {
  try {
    const { id } = req.params;
    let playbooks = getPlaybooks();
    const playbook = playbooks.find(p => p.id === id);
    
    if (playbook && fs.existsSync(`public/uploads/playbooks/${playbook.arquivo}`)) {
      fs.unlinkSync(`public/uploads/playbooks/${playbook.arquivo}`);
    }

    playbooks = playbooks.filter(p => p.id !== id);
    fs.writeFileSync(join(dataDir, 'playbooks.json'), JSON.stringify(playbooks, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analytics
app.get('/api/admin/analytics', isAdmin, (req, res) => {
  const leads = getLeads();
  const propostas = getPropostas();
  
  const totalLeads = leads.length;
  const totalPropostas = propostas.length;
  const ganhas = propostas.filter(p => p.status === 'Ganha').length;
  const perdidas = propostas.filter(p => p.status === 'Perdida').length;
  const taxaConversao = totalPropostas > 0 ? ((ganhas / totalPropostas) * 100).toFixed(2) : 0;

  res.json({
    totalLeads,
    totalPropostas,
    ganhas,
    perdidas,
    emNegociacao: totalPropostas - ganhas - perdidas,
    taxaConversao
  });
});

// Servidor
app.listen(PORT, () => {
  console.log(`🚀 GST Marketing rodando em http://localhost:${PORT}`);
});
