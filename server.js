require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { put, del } = require('@vercel/blob');
// Logging enabled for Vercel debugging
const log = console.log;
const _log = console.log;
const path     = require('path');
const fs       = require('fs');
const pool     = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

// SECURE JWT SECRET: Fallback only for local development
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' 
    ? (()=>{ throw new Error('JWT_SECRET must be set in production!'); })()
    : 'GKU_DEVELOPMENT_SECRET_KEY_123');

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Root & named routes ─────────────────────────────────────────────────────
app.get('/',      (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/results', (_req, res) => res.sendFile(path.join(__dirname, 'result.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── Static file serving ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Uploads folder (Only for local development) ──────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!process.env.VERCEL) {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    app.use('/uploads', express.static(UPLOAD_DIR));
}

// ── Multer (Memory storage for Vercel, Disk for local) ───────────────────────
const storage = (process.env.VERCEL || process.env.NODE_ENV === 'production')
    ? multer.memoryStorage() // Vercel uses memory + Blob
    : multer.diskStorage({   // Local uses disks
        destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
        filename:    (_req, file,  cb) => {
            const uid = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
            cb(null, `sem_result_${uid}${path.extname(file.originalname)}`);
        },
    });

const upload = multer({
    storage,
    fileFilter: (_req, file, cb) => {
        if (file.mimetype === 'application/pdf') return cb(null, true);
        cb(new Error('Only PDF files are allowed.'));
    },
    limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Auth helpers ──────────────────────────────────────────────────────────────
const requireStudent = (req, res, next) => {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'student') return res.status(403).json({ error: 'Forbidden' });
        req.student = decoded;
        next();
    } catch {
        res.status(401).json({ error: 'Session expired. Please login again.' });
    }
};

const requireAdmin = (req, res, next) => {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
        req.admin = decoded;
        next();
    } catch {
        res.status(401).json({ error: 'Session expired. Please login again.' });
    }
};

// ═══════════════════════════════════════════════════════════
//  STUDENT ROUTES
// ═══════════════════════════════════════════════════════════

// POST /api/student/login
app.post('/api/student/login', async (req, res) => {
    const start = Date.now();
    try {
        const { roll_no, password } = req.body;
        if (!roll_no?.trim() || !password)
            return res.status(400).json({ error: 'Roll number and password are required.' });

        const { rows } = await pool.query(
            'SELECT * FROM students WHERE LOWER(roll_no) = LOWER($1)',
            [roll_no.trim()]
        );
        if (!rows.length)
            return res.status(401).json({ error: 'Invalid roll number or password.' });

        const student = rows[0];
        const ok = await bcrypt.compare(password, student.password_hash);
        if (!ok)
            return res.status(401).json({ error: 'Invalid roll number or password.' });

        const token = jwt.sign(
            { id: student.id, roll_no: student.roll_no, name: student.name, role: 'student' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        log(`[${new Date().toTimeString().slice(0,8)}] LOGIN student ${student.roll_no} (${Date.now()-start}ms)`);
        return res.json({
            token,
            student: {
                id:          student.id,
                roll_no:     student.roll_no,
                name:        student.name,
                father_name: student.father_name,
                mother_name: student.mother_name,
                course:      student.course,
                branch:      student.branch,
                batch_year:  student.batch_year,
                email:       student.email,
            },
        });
    } catch (err) {
        _log(`[ERROR] student/login: ${err.message}`);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// GET /api/student/semesters  (auth required)
app.get('/api/student/semesters', requireStudent, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT semester, exam_session, declaration_date, result_status, percentage
             FROM   results
             WHERE  student_id = $1
             ORDER  BY semester ASC`,
            [req.student.id]
        );
        res.json({ semesters: rows });
    } catch (err) {
        _log(`[ERROR] student/semesters: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// GET /api/student/result/:semester  (auth required)
app.get('/api/student/result/:semester', requireStudent, async (req, res) => {
    try {
        const sem = parseInt(req.params.semester, 10);
        if (!sem || sem < 1 || sem > 6)
            return res.status(400).json({ error: 'Semester must be between 1 and 6.' });

        const { rows } = await pool.query(
            `SELECT r.*, s.name, s.roll_no, s.father_name, s.mother_name,
                    s.course, s.branch, s.batch_year, s.email
             FROM   results  r
             JOIN   students s ON r.student_id = s.id
             WHERE  r.student_id = $1 AND r.semester = $2`,
            [req.student.id, sem]
        );
        if (!rows.length)
            return res.status(404).json({ error: 'No result found for this semester.' });

        res.json({ result: rows[0] });
    } catch (err) {
        _log(`[ERROR] student/result: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ═══════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════

// POST /api/admin/login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({ error: 'Username and password required.' });

        const { rows } = await pool.query(
            'SELECT * FROM admins WHERE username = $1', [username]
        );
        if (!rows.length)
            return res.status(401).json({ error: 'Invalid credentials.' });

        const ok = await bcrypt.compare(password, rows[0].password_hash);
        if (!ok)
            return res.status(401).json({ error: 'Invalid credentials.' });

        const token = jwt.sign(
            { id: rows[0].id, username: rows[0].username, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '12h' }
        );
        log(`[${new Date().toTimeString().slice(0,8)}] LOGIN admin ${rows[0].username}`);
        res.json({ token, username: rows[0].username, full_name: rows[0].full_name });
    } catch (err) {
        _log(`[ERROR] admin/login: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// GET /api/admin/stats  — dashboard counts
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const [s, r] = await Promise.all([
            pool.query('SELECT COUNT(*) AS cnt FROM students'),
            pool.query('SELECT COUNT(*) AS cnt FROM results'),
        ]);
        const latest = await pool.query(
            `SELECT s.name, s.roll_no, r.semester, r.result_status, r.created_at
             FROM results r JOIN students s ON r.student_id = s.id
             ORDER BY r.created_at DESC LIMIT 5`
        );
        res.json({
            total_students: parseInt(s.rows[0].cnt),
            total_results:  parseInt(r.rows[0].cnt),
            recent:         latest.rows,
        });
    } catch (err) {
        _log(`[ERROR] admin/stats: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// POST /api/admin/students  — add student
app.post('/api/admin/students', requireAdmin, async (req, res) => {
    try {
        const { roll_no, password, name, father_name, mother_name, course, branch, batch_year, email, phone } = req.body;
        if (!roll_no?.trim() || !password || !name?.trim())
            return res.status(400).json({ error: 'Roll number, name, and password are required.' });

        const dup = await pool.query(
            'SELECT id FROM students WHERE LOWER(roll_no) = LOWER($1)', [roll_no.trim()]
        );
        if (dup.rows.length)
            return res.status(409).json({ error: `Roll number "${roll_no.trim()}" already exists.` });

        const hash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            `INSERT INTO students (roll_no, password_hash, name, father_name, mother_name, course, branch, batch_year, email, phone)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id, roll_no, name, father_name, course, branch, batch_year, created_at`,
            [roll_no.trim().toUpperCase(), hash, name.trim(), father_name || null, mother_name || null,
             course || null, branch || null, batch_year || null, email || null, phone || null]
        );
        log(`[${new Date().toTimeString().slice(0,8)}] ADD student ${rows[0].roll_no}`);
        res.status(201).json({ message: 'Student added successfully.', student: rows[0] });
    } catch (err) {
        _log(`[ERROR] admin/students POST: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// GET /api/admin/students  — list all students
app.get('/api/admin/students', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, roll_no, name, father_name, course, branch, batch_year, email, phone, created_at
             FROM students ORDER BY created_at DESC`
        );
        res.json({ students: rows });
    } catch (err) {
        _log(`[ERROR] admin/students GET: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// PUT /api/admin/students/:id/password  — reset password
app.put('/api/admin/students/:id/password', requireAdmin, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'New password required.' });
        const hash = await bcrypt.hash(password, 10);
        const { rowCount } = await pool.query(
            'UPDATE students SET password_hash=$1 WHERE id=$2', [hash, req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'Student not found.' });
        res.json({ message: 'Password updated successfully.' });
    } catch (err) {
        _log(`[ERROR] admin/student reset-pw: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// DELETE /api/admin/students/:id  — delete student + their results + PDFs
app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
    try {
        const pdfs = await pool.query('SELECT pdf_path FROM results WHERE student_id=$1', [req.params.id]);
        for (const { pdf_path } of pdfs.rows) {
            if (pdf_path) {
                if (pdf_path.startsWith('http')) {
                    // Delete from Vercel Blob
                    try { await del(pdf_path); } catch (e) { _log(`[BLOB DEL ERROR] ${e.message}`); }
                } else {
                    // Delete from local disk
                    const fp = path.join(UPLOAD_DIR, path.basename(pdf_path));
                    if (fs.existsSync(fp)) fs.unlinkSync(fp);
                }
            }
        }
        await pool.query('DELETE FROM students WHERE id=$1', [req.params.id]);
        res.json({ message: 'Student and all related results deleted.' });
    } catch (err) {
        _log(`[ERROR] admin/student DELETE: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// POST /api/admin/results  — add / update marks-type result
app.post('/api/admin/results', requireAdmin, async (req, res) => {
    try {
        const { student_id, semester, subjects, total_marks, obtained_marks,
                percentage, result_status, declaration_date, exam_session, remarks } = req.body;

        if (!student_id || !semester)
            return res.status(400).json({ error: 'Student ID and semester are required.' });
        if (semester < 1 || semester > 6)
            return res.status(400).json({ error: 'Semester must be between 1 and 6.' });

        const existing = await pool.query(
            'SELECT id, pdf_path FROM results WHERE student_id=$1 AND semester=$2',
            [student_id, semester]
        );

        const subjectsJson = typeof subjects === 'string' ? subjects : JSON.stringify(subjects);

        if (existing.rows.length) {
            // Remove old PDF if switching to marks
            if (existing.rows[0].pdf_path) {
                const oldPath = existing.rows[0].pdf_path;
                if (oldPath.startsWith('http')) {
                    try { await del(oldPath); } catch (e) { _log(`[BLOB DEL ERROR] ${e.message}`); }
                } else {
                    const fp = path.join(UPLOAD_DIR, path.basename(oldPath));
                    if (fs.existsSync(fp)) fs.unlinkSync(fp);
                }
            }
            await pool.query(
                `UPDATE results
                 SET result_type='marks', subjects=$1, pdf_path=NULL,
                     total_marks=$2, obtained_marks=$3, percentage=$4,
                     result_status=$5, declaration_date=$6, exam_session=$7, remarks=$8
                 WHERE student_id=$9 AND semester=$10`,
                [subjectsJson, total_marks || null, obtained_marks || null, percentage || null,
                 result_status || 'Pass', declaration_date || null, exam_session || null,
                 remarks || null, student_id, semester]
            );
            return res.json({ message: 'Result updated successfully.' });
        }

        await pool.query(
            `INSERT INTO results (student_id, semester, result_type, subjects, total_marks, obtained_marks,
             percentage, result_status, declaration_date, exam_session, remarks)
             VALUES ($1,$2,'marks',$3,$4,$5,$6,$7,$8,$9,$10)`,
            [student_id, semester, subjectsJson, total_marks || null, obtained_marks || null,
             percentage || null, result_status || 'Pass', declaration_date || null,
             exam_session || null, remarks || null]
        );
        res.status(201).json({ message: 'Result added successfully.' });
    } catch (err) {
        _log(`[ERROR] admin/results POST: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// POST /api/admin/results/pdf  — upload PDF result
app.post('/api/admin/results/pdf', requireAdmin, upload.single('pdf'), async (req, res) => {
    try {
        const { student_id, semester, declaration_date, exam_session, result_status, remarks } = req.body;
        if (!student_id || !semester)
            return res.status(400).json({ error: 'Student ID and semester are required.' });
        if (!req.file)
            return res.status(400).json({ error: 'PDF file is required.' });

        let pdfPath = '';
        if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
            // Upload to Vercel Blob
            const blob = await put(`results/sem_result_${Date.now()}.pdf`, req.file.buffer, {
                access: 'public',
            });
            pdfPath = blob.url;
        } else {
            // Local fallback
            pdfPath = `/uploads/${req.file.filename}`;
        }

        const existing = await pool.query(
            'SELECT id, pdf_path FROM results WHERE student_id=$1 AND semester=$2',
            [student_id, semester]
        );

        if (existing.rows.length) {
            // Remove old PDF
            const oldPath = existing.rows[0].pdf_path;
            if (oldPath) {
                if (oldPath.startsWith('http')) {
                    try { await del(oldPath); } catch (e) { _log(`[BLOB DEL ERROR] ${e.message}`); }
                } else {
                    const fp = path.join(UPLOAD_DIR, path.basename(oldPath));
                    if (fs.existsSync(fp)) fs.unlinkSync(fp);
                }
            }
            await pool.query(
                `UPDATE results
                 SET result_type='pdf', pdf_path=$1, subjects=NULL, total_marks=NULL,
                     obtained_marks=NULL, percentage=NULL,
                     declaration_date=$2, exam_session=$3, result_status=$4, remarks=$5
                 WHERE student_id=$6 AND semester=$7`,
                [pdfPath, declaration_date || null, exam_session || null,
                 result_status || 'Pass', remarks || null, student_id, semester]
            );
            return res.json({ message: 'PDF result updated successfully.', pdf_path: pdfPath });
        }

        await pool.query(
            `INSERT INTO results (student_id, semester, result_type, pdf_path,
             declaration_date, exam_session, result_status, remarks)
             VALUES ($1,$2,'pdf',$3,$4,$5,$6,$7)`,
            [student_id, semester, pdfPath, declaration_date || null,
             exam_session || null, result_status || 'Pass', remarks || null]
        );
        res.status(201).json({ message: 'PDF uploaded successfully.', pdf_path: pdfPath });
    } catch (err) {
        _log(`[ERROR] admin/results/pdf: ${err.message}`);
        if (req.file && !req.file.buffer) { // Only unlink if it was a disk file
            const fp = path.join(UPLOAD_DIR, req.file.filename);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        }
        res.status(500).json({ error: err.message || 'Server error.' });
    }
});

// GET /api/admin/results  — list all results
app.get('/api/admin/results', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT r.id, r.semester, r.result_type, r.percentage, r.result_status,
                    r.exam_session, r.declaration_date, r.created_at, r.pdf_path,
                    s.name, s.roll_no, s.course, s.branch, s.id AS student_id
             FROM   results  r
             JOIN   students s ON r.student_id = s.id
             ORDER  BY s.roll_no, r.semester ASC`
        );
        log(`[DB] Fetched ${rows.length} results from database.`);
        res.json({ results: rows });
    } catch (err) {
        console.error(`[ERROR] admin/results GET: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// DELETE /api/admin/results/:id  — delete one result
app.delete('/api/admin/results/:id', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT pdf_path FROM results WHERE id=$1', [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Result not found.' });
        if (rows[0].pdf_path) {
            const oldPath = rows[0].pdf_path;
            if (oldPath.startsWith('http')) {
                try { await del(oldPath); } catch (e) { _log(`[BLOB DEL ERROR] ${e.message}`); }
            } else {
                const fp = path.join(UPLOAD_DIR, path.basename(oldPath));
                if (fs.existsSync(fp)) fs.unlinkSync(fp);
            }
        }
        await pool.query('DELETE FROM results WHERE id=$1', [req.params.id]);
        res.json({ message: 'Result deleted.' });
    } catch (err) {
        _log(`[ERROR] admin/results DELETE: ${err.message}`);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', service: 'GKU Result System', ts: new Date().toISOString() })
);



// ─────────────────────────────────────────────────────────────────────────────
//  AUTO-INIT: Create default admin on first startup
// ─────────────────────────────────────────────────────────────────────────────
async function initDefaults() {
    try {
        const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM admins');
        if (parseInt(rows[0].cnt) === 0) {
            const hash = await bcrypt.hash('admin123', 10);
            await pool.query(
                `INSERT INTO admins (username, password_hash, full_name)
                 VALUES ('admin', $1, 'System Administrator')`,
                [hash]
            );
            log('Default admin created  →  admin / admin123');
        }
    } catch (err) {
        _log(`[ERROR] DB init failed — run setup_db.sql first: ${err.message}`);
    }
}

// ── Start server ────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, () => {
        log(`GKU Result System running on http://localhost:${PORT}`);
    });
}

// Ensure defaults (like admin account) are created on all environments (Vercel & Local)
initDefaults();

module.exports = app;
