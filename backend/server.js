require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'secret123';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'refreshsecret123';

// Security: Helmet sets secure HTTP headers
app.use(helmet());

// CORS: reflect the request origin so browser clients can send credentialed requests
app.use(cors({
    origin: true,
    credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// Serve backups directory (public read) — ensure backups path exists
const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
app.use('/backups', express.static(backupsDir));

// Rate limiting: apply general limiter to API and stricter limiter for auth
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10, // stricter for auth endpoints
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many auth attempts, please try again later.' }
});
app.use('/api/auth/', authLimiter);

// --- Validation helper ---
const validate = (validations) => async (req, res, next) => {
    for (let validation of validations) {
        await validation.run(req);
    }
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
};

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- MODELS ---
// 1. User Model
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'User' },
    refreshTokens: { type: [String], default: [] }
});
const User = mongoose.model('User', userSchema);

// 2. Expense Model
const expenseSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Linked to User
    title: String,
    amount: Number,
    type: String,
    category: String,
    date: { type: Date, default: Date.now }
});
// Indexes for performance
expenseSchema.index({ userId: 1, date: -1 });
expenseSchema.index({ category: 1 });
const Expense = mongoose.model('Expense', expenseSchema);

// --- Audit Log Model ---
const auditSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    action: { type: String, required: true },
    resource: { type: String },
    details: { type: mongoose.Schema.Types.Mixed },
    ip: String,
    userAgent: String,
    createdAt: { type: Date, default: Date.now }
});
auditSchema.index({ userId: 1, createdAt: -1 });
auditSchema.index({ action: 1 });
auditSchema.index({ resource: 1 });
const AuditLog = mongoose.model('AuditLog', auditSchema);

// Helper to record audit logs
const recordAudit = async ({ userId, action, resource = '', details = {}, req = null }) => {
    try {
        const entry = new AuditLog({
            userId: userId || null,
            action,
            resource,
            details,
            ip: req ? (req.ip || req.headers['x-forwarded-for'] || '') : '',
            userAgent: req ? req.headers['user-agent'] : ''
        });
        await entry.save();
    } catch (err) {
        console.error('Failed to record audit log', err);
    }
};


// Middleware to verify JWT access tokens
const authMiddleware = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ error: "Access Denied" });

    try {
        const verified = jwt.verify(token, JWT_SECRET);
        const authenticatedUserId = verified.id || verified.userId || verified._id;
        if (!authenticatedUserId) {
            return res.status(401).json({ error: 'Invalid Token' });
        }

        req.user = { ...verified, id: authenticatedUserId.toString() };
        next();
    } catch (err) {
        res.status(400).json({ error: "Invalid Token" });
    }
};
// --- AUTH ROUTES ---

// Register
app.post('/api/auth/register',
    validate([
        body('name').trim().notEmpty().withMessage('Name is required'),
        body('email').isEmail().withMessage('Valid email is required'),
        body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
    ]),
    async (req, res) => {
        try {
            const { name, email, password } = req.body;

            // Check if user exists
            const existingUser = await User.findOne({ email });
            if (existingUser) return res.status(400).json({ error: "User already exists" });

            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);

            // Save user
            const newUser = new User({ name, email, password: hashedPassword });
            await newUser.save();

            res.status(201).json({ message: "User registered successfully" });
            // Audit: user registered
            await recordAudit({ userId: newUser._id, action: 'register', resource: 'user', details: { email }, req });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

// Login
app.post('/api/auth/login',
    validate([
        body('email').isEmail().withMessage('Valid email is required'),
        body('password').exists().withMessage('Password is required')
    ]),
    async (req, res) => {
        try {
            const { email, password } = req.body;

            // Find user
            const user = await User.findOne({ email });
            if (!user) return res.status(400).json({ error: "User not found" });

            // Check password
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

            // Generate Token
            const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });
            const refreshToken = jwt.sign({ id: user._id }, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });

            // Store refresh token (allow multiple devices)
            user.refreshTokens = user.refreshTokens || [];
            user.refreshTokens.push(refreshToken);
            await user.save();

            // Set HttpOnly cookie for refresh token
            res.cookie('refreshToken', refreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000
            });

            // Audit: login
            await recordAudit({ userId: user._id, action: 'login', resource: 'auth', details: { email }, req });

            res.json({
                token,
                user: { id: user._id, name: user.name, email: user.email }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

// Refresh access token
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const incoming = req.cookies.refreshToken || req.body.refreshToken || req.headers['x-refresh-token'];
        if (!incoming) return res.status(401).json({ error: 'Refresh token required' });

        let payload;
        try {
            payload = jwt.verify(incoming, REFRESH_TOKEN_SECRET);
        } catch (err) {
            return res.status(403).json({ error: 'Invalid refresh token' });
        }

        const user = await User.findById(payload.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Ensure the refresh token exists for this user
        if (!user.refreshTokens || !user.refreshTokens.includes(incoming)) {
            return res.status(403).json({ error: 'Refresh token revoked' });
        }

        // Rotate refresh token: issue new access + refresh
        const newAccessToken = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });
        const newRefreshToken = jwt.sign({ id: user._id }, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });

        // Replace old refresh token
        user.refreshTokens = user.refreshTokens.filter(t => t !== incoming);
        user.refreshTokens.push(newRefreshToken);
        await user.save();

        // Set cookie
        res.cookie('refreshToken', newRefreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        // Audit: token refreshed
        await recordAudit({ userId: user._id, action: 'refresh', resource: 'auth', details: {}, req });
        res.json({ token: newAccessToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Logout (revoke refresh token)
app.post('/api/auth/logout', async (req, res) => {
    try {
        const incoming = req.cookies.refreshToken || req.body.refreshToken || req.headers['x-refresh-token'];
        if (!incoming) {
            // Clear cookie anyway
            res.clearCookie('refreshToken');
            return res.status(400).json({ error: 'Refresh token required' });
        }

        let payload;
        try {
            payload = jwt.verify(incoming, REFRESH_TOKEN_SECRET);
        } catch (err) {
            // Even if token invalid, respond with success to avoid token fishing
            return res.json({ message: 'Logged out' });
        }

        const user = await User.findById(payload.id);
        if (!user) return res.json({ message: 'Logged out' });

        user.refreshTokens = (user.refreshTokens || []).filter(t => t !== incoming);
        await user.save();
        res.clearCookie('refreshToken');
        // Audit: logout
        await recordAudit({ userId: user._id, action: 'logout', resource: 'auth', details: {}, req });
        res.json({ message: 'Logged out' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Logout from all devices (clear all refresh tokens) - requires auth
app.post('/api/auth/logout-all', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        user.refreshTokens = [];
        await user.save();

        // Audit: logout-all
        await recordAudit({ userId: user._id, action: 'logout_all', resource: 'auth', details: {}, req });

        res.json({ message: 'Logged out from all devices' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- EXPENSE ROUTES (Protected) ---
// Admin check middleware
const isAdmin = async (req, res, next) => {
    try {
        if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized' });
        const u = await User.findById(req.user.id);
        if (!u || u.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
        req.currentUser = u;
        next();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

app.get('/api/expenses', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20, category, type, startDate, endDate } = req.query;
        const query = { userId: req.user.id };
        if (category) query.category = category;
        if (type) query.type = type;
        if (startDate || endDate) {
            query.date = {};
            if (startDate) query.date.$gte = new Date(startDate);
            if (endDate) query.date.$lte = new Date(endDate);
        }

        const pageNum = Math.max(1, parseInt(page, 10));
        const lim = Math.max(1, Math.min(100, parseInt(limit, 10)));

        const [items, total] = await Promise.all([
            Expense.find(query).sort({ date: -1 }).skip((pageNum - 1) * lim).limit(lim),
            Expense.countDocuments(query)
        ]);

        res.json({ items, total, page: pageNum, pages: Math.ceil(total / lim) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Aggregated report: totals by category and overview for a range
app.get('/api/reports/summary', authMiddleware, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const match = { userId: mongoose.Types.ObjectId(req.user.id) };
        if (startDate || endDate) {
            match.date = {};
            if (startDate) match.date.$gte = new Date(startDate);
            if (endDate) match.date.$lte = new Date(endDate);
        }

        const agg = await Expense.aggregate([
            { $match: match },
            {
                $group: {
                    _id: '$category',
                    total: { $sum: '$amount' }
                }
            },
            { $sort: { total: -1 } }
        ]);

        // compute totals
        const totals = agg.reduce((acc, cur) => ({ ...acc, [cur._id]: cur.total }), {});
        const overall = await Expense.aggregate([
            { $match: match },
            { $group: { _id: null, sum: { $sum: '$amount' } } }
        ]);

        res.json({ byCategory: agg, total: overall[0] ? overall[0].sum : 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// (validated POST /api/expenses is defined below)

// Validate expense creation
app.post('/api/expenses',
    authMiddleware,
    validate([
        body('title').trim().notEmpty().withMessage('Title is required'),
        body('amount').isNumeric().withMessage('Amount must be a number'),
        body('category').trim().notEmpty().withMessage('Category is required'),
        body('type').isIn(['expense', 'income', 'investment', 'withdrawal']).withMessage('Invalid type')
    ]),
    async (req, res) => {
        try {
            const newExpense = new Expense({ ...req.body, userId: req.user.id });
            const saved = await newExpense.save();
            // Audit: created expense
            await recordAudit({ userId: req.user.id, action: 'create', resource: 'expense', details: { expenseId: saved._id, title: saved.title, amount: saved.amount }, req });
            res.json(saved);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

app.delete('/api/expenses/:id', authMiddleware, async (req, res) => {
    try {
        const found = await Expense.findById(req.params.id);
        await Expense.findByIdAndDelete(req.params.id);
        // Audit: deleted expense
        await recordAudit({ userId: req.user.id, action: 'delete', resource: 'expense', details: { expenseId: req.params.id, title: found ? found.title : null }, req });
        res.json({ message: "Deleted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Global error handler
app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    console.error('Unhandled error:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// --- Swagger/OpenAPI ---
const openapi = {
    openapi: '3.0.0',
    info: { title: 'Expense Tracker API', version: '1.0.0' },
    servers: [{ url: process.env.API_BASE_URL || 'http://localhost:5000/api' }],
    paths: {
        '/auth/login': {
            post: {
                summary: 'Login',
                requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
                responses: { '200': { description: 'OK' } }
            }
        },
        '/auth/register': { post: { summary: 'Register' } },
        '/expenses': { get: { summary: 'List expenses' }, post: { summary: 'Create expense' } }
    }
};
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi));

// --- Logs endpoint ---
app.get('/api/logs', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 50, action, userId, startDate, endDate } = req.query;
        const q = {};
        // only allow fetching all users if requester is admin
        if (userId) {
            // require admin to query arbitrary userId
            if (String(req.user.id) !== String(userId)) {
                const u = await User.findById(req.user.id);
                if (!u || u.role !== 'Admin') return res.status(403).json({ error: 'Admin required to query other users' });
            }
            q.userId = mongoose.Types.ObjectId(userId);
        } else {
            q.userId = req.user.id; // default to own logs
        }

        if (action) q.action = action;
        if (startDate || endDate) {
            q.createdAt = {};
            if (startDate) q.createdAt.$gte = new Date(startDate);
            if (endDate) q.createdAt.$lte = new Date(endDate);
        }

        const pageNum = Math.max(1, parseInt(page, 10));
        const lim = Math.max(1, Math.min(200, parseInt(limit, 10)));

        const [items, total] = await Promise.all([
            AuditLog.find(q).sort({ createdAt: -1 }).skip((pageNum - 1) * lim).limit(lim),
            AuditLog.countDocuments(q)
        ]);

        res.json({ items, total, page: pageNum, pages: Math.ceil(total / lim) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export logs as CSV (admin required when exporting others)
const { stringify } = require('csv-stringify/sync');

app.get('/api/logs/export', authMiddleware, async (req, res) => {
    try {
        const { action, userId, startDate, endDate } = req.query;
        const q = {};
        if (userId) {
            if (String(req.user.id) !== String(userId)) {
                const u = await User.findById(req.user.id);
                if (!u || u.role !== 'Admin') return res.status(403).json({ error: 'Admin required to export other users logs' });
            }
            q.userId = mongoose.Types.ObjectId(userId);
        } else {
            q.userId = req.user.id;
        }
        if (action) q.action = action;
        if (startDate || endDate) {
            q.createdAt = {};
            if (startDate) q.createdAt.$gte = new Date(startDate);
            if (endDate) q.createdAt.$lte = new Date(endDate);
        }

        const items = await AuditLog.find(q).sort({ createdAt: -1 }).lean();
        const records = items.map(i => ({
            createdAt: i.createdAt.toISOString(),
            userId: i.userId ? String(i.userId) : '',
            action: i.action,
            resource: i.resource || '',
            details: typeof i.details === 'object' ? JSON.stringify(i.details) : String(i.details),
            ip: i.ip || '',
            userAgent: i.userAgent || ''
        }));

        const csv = stringify(records, { header: true });
        const filename = `logs-${Date.now()}.csv`;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cleanup logs older than retention days (admin only)
app.post('/api/logs/cleanup', authMiddleware, isAdmin, async (req, res) => {
    try {
        const days = parseInt(process.env.LOG_RETENTION_DAYS || '90', 10);
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const result = await AuditLog.deleteMany({ createdAt: { $lt: cutoff } });
        await recordAudit({ userId: req.user.id, action: 'cleanup_logs', resource: 'logs', details: { deleted: result.deletedCount }, req });
        res.json({ deleted: result.deletedCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Backup logs to server-side file and return path (admin only)
app.post('/api/logs/backup', authMiddleware, isAdmin, async (req, res) => {
    try {
        const { startDate, endDate } = req.body || {};
        const q = {};
        if (startDate || endDate) {
            q.createdAt = {};
            if (startDate) q.createdAt.$gte = new Date(startDate);
            if (endDate) q.createdAt.$lte = new Date(endDate);
        }
        const items = await AuditLog.find(q).sort({ createdAt: -1 }).lean();
        const records = items.map(i => ({
            createdAt: i.createdAt.toISOString(),
            userId: i.userId ? String(i.userId) : '',
            action: i.action,
            resource: i.resource || '',
            details: typeof i.details === 'object' ? JSON.stringify(i.details) : String(i.details),
            ip: i.ip || '',
            userAgent: i.userAgent || ''
        }));

        const csv = stringify(records, { header: true });
        const backupsDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
        const filename = `logs-backup-${Date.now()}.csv`;
        const filePath = path.join(backupsDir, filename);
        fs.writeFileSync(filePath, csv);

        await recordAudit({ userId: req.user.id, action: 'backup_logs', resource: 'logs', details: { file: filename }, req });
        res.json({ file: `/backups/${filename}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));