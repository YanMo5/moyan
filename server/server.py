import http.server
import socketserver
import json
import sqlite3
import os
import secrets
import time
import hashlib
import hmac
import csv
import io
from urllib.parse import urlparse, parse_qs
from http import cookies

PORT = 3000
SESSION_COOKIE_NAME = 'yanmo_admin_session'
SESSION_TTL_SECONDS = 12 * 60 * 60
CSRF_HEADER_NAME = 'X-CSRF-Token'
PASSWORD_HASH_ITERATIONS = 210000
LOGIN_WINDOW_SECONDS = 10 * 60
LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCK_SECONDS = 15 * 60
ADMIN_SESSIONS = {}
LOGIN_FAILURES = {}

# 数据库路径
db_path = os.path.join(os.path.dirname(__file__), '..', 'blog.db')
root_dir = os.path.join(os.path.dirname(__file__), '..')
admin_password_file = os.path.join(root_dir, 'admin_password.txt')
admin_credentials_file = os.path.join(root_dir, 'admin_credentials.json')


def read_legacy_admin_password():
    if not os.path.exists(admin_password_file):
        return 'admin'

    with open(admin_password_file, 'r', encoding='utf-8') as f:
        return f.read().strip() or 'admin'


def hash_password(password, salt_hex=None, iterations=PASSWORD_HASH_ITERATIONS):
    salt = bytes.fromhex(salt_hex) if salt_hex else os.urandom(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, int(iterations))
    return {
        'password_salt': salt.hex(),
        'password_hash': digest.hex(),
        'password_iterations': int(iterations)
    }


def verify_password(password, salt_hex, hash_hex, iterations):
    try:
        digest = hashlib.pbkdf2_hmac(
            'sha256',
            password.encode('utf-8'),
            bytes.fromhex(str(salt_hex)),
            int(iterations)
        ).hex()
        return hmac.compare_digest(digest, str(hash_hex))
    except (ValueError, TypeError):
        return False


def get_admin_credentials():
    default_password = read_legacy_admin_password()
    default_hash = hash_password(default_password)
    default_credentials = {'username': 'admin', **default_hash}

    if os.path.exists(admin_credentials_file):
        try:
            with open(admin_credentials_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            username = str(data.get('username', '')).strip() or default_credentials['username']

            salt = str(data.get('password_salt', '')).strip()
            password_hash = str(data.get('password_hash', '')).strip()
            iterations = int(data.get('password_iterations', PASSWORD_HASH_ITERATIONS) or PASSWORD_HASH_ITERATIONS)

            if salt and password_hash:
                return {
                    'username': username,
                    'password_salt': salt,
                    'password_hash': password_hash,
                    'password_iterations': iterations
                }

            legacy_password = str(data.get('password', '')).strip() or default_password
            migrated_hash = hash_password(legacy_password)
            save_admin_credentials(username, migrated_hash)
            return {'username': username, **migrated_hash}
        except (json.JSONDecodeError, OSError, AttributeError):
            pass

    save_admin_credentials(default_credentials['username'], default_credentials)
    return default_credentials


def save_admin_credentials(username, password_record):
    safe_record = {
        'password_salt': str(password_record.get('password_salt', '')),
        'password_hash': str(password_record.get('password_hash', '')),
        'password_iterations': int(password_record.get('password_iterations', PASSWORD_HASH_ITERATIONS) or PASSWORD_HASH_ITERATIONS)
    }

    credentials = {
        'username': username,
        **safe_record
    }

    with open(admin_credentials_file, 'w', encoding='utf-8') as f:
        json.dump(credentials, f, ensure_ascii=False)

    # 覆盖旧明文文件，避免继续暴露真实密码。
    with open(admin_password_file, 'w', encoding='utf-8') as f:
        f.write('managed_by_hash_credentials')


def get_client_identifier(handler):
    forwarded = str(handler.headers.get('X-Forwarded-For', '')).strip()
    if forwarded:
        return forwarded.split(',')[0].strip() or 'unknown'
    return str(handler.client_address[0] if handler.client_address else 'unknown')


def clear_login_failures(client_id):
    LOGIN_FAILURES.pop(client_id, None)


def check_login_lock(client_id):
    now = int(time.time())
    entry = LOGIN_FAILURES.get(client_id)
    if not entry:
        return 0

    lock_until = int(entry.get('lock_until', 0) or 0)
    if lock_until > now:
        return lock_until - now

    attempts = [ts for ts in entry.get('attempts', []) if ts >= now - LOGIN_WINDOW_SECONDS]
    if attempts:
        entry['attempts'] = attempts
        entry['lock_until'] = 0
        LOGIN_FAILURES[client_id] = entry
    else:
        LOGIN_FAILURES.pop(client_id, None)
    return 0


def record_login_failure(client_id):
    now = int(time.time())
    entry = LOGIN_FAILURES.get(client_id, {'attempts': [], 'lock_until': 0})
    attempts = [ts for ts in entry.get('attempts', []) if ts >= now - LOGIN_WINDOW_SECONDS]
    attempts.append(now)
    entry['attempts'] = attempts
    if len(attempts) >= LOGIN_MAX_ATTEMPTS:
        entry['lock_until'] = now + LOGIN_LOCK_SECONDS
    LOGIN_FAILURES[client_id] = entry


def user_agent_fingerprint(user_agent):
    source = str(user_agent or '')
    return hashlib.sha256(source.encode('utf-8')).hexdigest()[:24]


def write_admin_audit_log(action, status, client_ip, username='', detail=''):
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute(
        'INSERT INTO admin_audit_logs (action, status, username, client_ip, detail) VALUES (?, ?, ?, ?, ?)',
        (
            str(action or '')[:120],
            str(status or '')[:20],
            str(username or '')[:80],
            str(client_ip or '')[:80],
            str(detail or '')[:500]
        )
    )
    conn.commit()
    conn.close()


def ensure_database_schema():
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # 兼容旧库：为 links 表补充站点头像字段。
    c.execute("PRAGMA table_info(links)")
    columns = [row[1] for row in c.fetchall()]
    if 'site_avatar' not in columns:
        c.execute("ALTER TABLE links ADD COLUMN site_avatar TEXT DEFAULT ''")
        conn.commit()

    c.execute(
        '''
        CREATE TABLE IF NOT EXISTS admin_audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            username TEXT DEFAULT '',
            client_ip TEXT DEFAULT '',
            detail TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        '''
    )
    conn.commit()

    conn.close()


def is_valid_http_url(value):
    try:
        parsed = urlparse(str(value or '').strip())
        return parsed.scheme in ('http', 'https') and bool(parsed.netloc)
    except Exception:
        return False


def cleanup_expired_sessions():
    now = int(time.time())
    expired = [sid for sid, session_data in ADMIN_SESSIONS.items() if int(session_data.get('expires_at', 0) or 0) <= now]
    for sid in expired:
        ADMIN_SESSIONS.pop(sid, None)


def parse_positive_int(value, default_value, min_value=1, max_value=100):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default_value
    return max(min_value, min(max_value, parsed))

class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # 更改工作目录到网站根目录
        super().__init__(*args, directory=os.path.join(os.path.dirname(__file__), '..'), **kwargs)

    def is_local_request(self):
        client_ip = str(self.client_address[0] if self.client_address else '')
        return client_ip in ('127.0.0.1', '::1', 'localhost') or client_ip.startswith('::ffff:127.0.0.1')

    def send_json(self, payload, status_code=200, extra_headers=None):
        self.send_response(status_code)
        self.send_header('Content-type', 'application/json')
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode('utf-8'))

    def get_client_ip(self):
        return get_client_identifier(self)

    def get_request_user_agent(self):
        return str(self.headers.get('User-Agent', '') or '')

    def read_json_body(self):
        content_length = int(self.headers.get('Content-Length', 0) or 0)
        raw_data = self.rfile.read(content_length) if content_length > 0 else b'{}'
        try:
            return json.loads(raw_data.decode('utf-8')) if raw_data else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def get_session_id(self):
        cookie_header = self.headers.get('Cookie', '')
        if not cookie_header:
            return ''
        parsed = cookies.SimpleCookie()
        try:
            parsed.load(cookie_header)
        except cookies.CookieError:
            return ''
        morsel = parsed.get(SESSION_COOKIE_NAME)
        return str(morsel.value) if morsel else ''

    def get_active_session(self):
        cleanup_expired_sessions()
        sid = self.get_session_id()
        if not sid:
            return None
        session_data = ADMIN_SESSIONS.get(sid)
        if not session_data:
            return None
        if int(session_data.get('expires_at', 0) or 0) <= int(time.time()):
            ADMIN_SESSIONS.pop(sid, None)
            return None

        expected_fp = str(session_data.get('ua_fingerprint', '') or '')
        current_fp = user_agent_fingerprint(self.get_request_user_agent())
        if expected_fp and not hmac.compare_digest(expected_fp, current_fp):
            ADMIN_SESSIONS.pop(sid, None)
            write_admin_audit_log(
                action='session_invalidated',
                status='denied',
                username=session_data.get('username', ''),
                client_ip=self.get_client_ip(),
                detail='user_agent_mismatch'
            )
            return None

        # Sliding expiration for active admin sessions.
        session_data['expires_at'] = int(time.time()) + SESSION_TTL_SECONDS
        ADMIN_SESSIONS[sid] = session_data
        return session_data

    def is_admin_authenticated(self):
        return self.get_active_session() is not None

    def require_admin_authenticated(self):
        if self.is_admin_authenticated():
            return True
        write_admin_audit_log(
            action='admin_auth_required',
            status='denied',
            username='',
            client_ip=self.get_client_ip(),
            detail='missing_or_expired_session'
        )
        self.send_json({'error': '请先登录管理员账户'}, 401)
        return False

    def require_admin_csrf(self):
        session_data = self.get_active_session()
        if not session_data:
            self.send_json({'error': '请先登录管理员账户'}, 401)
            return False

        provided_token = str(self.headers.get(CSRF_HEADER_NAME, '') or '').strip()
        expected_token = str(session_data.get('csrf_token', '') or '').strip()
        if not provided_token or not expected_token or not hmac.compare_digest(provided_token, expected_token):
            write_admin_audit_log(
                action='csrf_check',
                status='denied',
                username=session_data.get('username', ''),
                client_ip=self.get_client_ip(),
                detail='invalid_or_missing_token'
            )
            self.send_json({'error': 'CSRF token 无效或缺失'}, 403)
            return False
        return True

    def create_admin_session(self, username):
        cleanup_expired_sessions()
        sid = secrets.token_urlsafe(32)
        csrf_token = secrets.token_urlsafe(24)
        ADMIN_SESSIONS[sid] = {
            'expires_at': int(time.time()) + SESSION_TTL_SECONDS,
            'csrf_token': csrf_token,
            'username': str(username or ''),
            'ua_fingerprint': user_agent_fingerprint(self.get_request_user_agent())
        }
        return sid, csrf_token

    def clear_admin_session(self):
        sid = self.get_session_id()
        if sid:
            ADMIN_SESSIONS.pop(sid, None)
    
    def do_GET(self):
        parsed_url = urlparse(self.path)
        request_path = parsed_url.path
        normalized_path = request_path.rstrip('/')
        query = parse_qs(parsed_url.query)

        if request_path == '/api/messages':
            if not self.require_admin_authenticated():
                return

            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute('SELECT * FROM messages ORDER BY created_at DESC')
            messages = c.fetchall()
            conn.close()
            
            # 转换为字典列表
            messages_list = []
            for msg in messages:
                messages_list.append({
                    'id': msg[0],
                    'name': msg[1],
                    'email': msg[2],
                    'message': msg[3],
                    'created_at': msg[4]
                })
            
            self.send_json(messages_list, 200)
            
        elif request_path == '/api/links':
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute('SELECT * FROM links ORDER BY created_at DESC')
            links = c.fetchall()
            conn.close()
            
            # 转换为字典列表
            links_list = []
            for link in links:
                links_list.append({
                    'id': link[0],
                    'site_name': link[1],
                    'site_url': link[2],
                    'site_description': link[3],
                    'status': link[4],
                    'created_at': link[5],
                    'site_avatar': link[6] if len(link) > 6 else ''
                })
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(links_list).encode('utf-8'))
            
        elif request_path == '/api/articles':
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute('SELECT * FROM articles ORDER BY created_at DESC')
            articles = c.fetchall()
            conn.close()
            
            # 转换为字典列表
            articles_list = []
            for article in articles:
                articles_list.append({
                    'id': article[0],
                    'title': article[1],
                    'content': article[2],
                    'category': article[3],
                    'created_at': article[4]
                })
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(articles_list).encode('utf-8'))

        elif normalized_path.startswith('/api/articles/'):
            article_id = normalized_path.split('/')[-1]

            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute('SELECT * FROM articles WHERE id = ?', (article_id,))
            article = c.fetchone()
            conn.close()

            if not article:
                self.send_response(404)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'Article not found'}).encode('utf-8'))
                return

            article_data = {
                'id': article[0],
                'title': article[1],
                'content': article[2],
                'category': article[3],
                'created_at': article[4]
            }

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(article_data).encode('utf-8'))
            
        elif request_path == '/api/stats':
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            
            # 获取待审核友链数量
            c.execute('SELECT COUNT(*) FROM links WHERE status = ?', ('pending',))
            pending_links = c.fetchone()[0]
            
            # 获取已发布文章数量
            c.execute('SELECT COUNT(*) FROM articles')
            published_articles = c.fetchone()[0]
            
            # 简单的访问量统计（实际项目中应该使用更复杂的方法）
            # 这里我们使用一个简单的文件来存储访问量
            views_file = os.path.join(os.path.dirname(__file__), '..', 'views.txt')
            if not os.path.exists(views_file):
                with open(views_file, 'w') as f:
                    f.write('1000')
            
            with open(views_file, 'r') as f:
                views = int(f.read())
            
            # 每次访问增加10个访问量（模拟）
            views += 10
            with open(views_file, 'w') as f:
                f.write(str(views))
            
            conn.close()
            
            stats = {
                'pending_links': pending_links,
                'published_articles': published_articles,
                'total_views': views
            }
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(stats).encode('utf-8'))

        elif request_path == '/api/admin-audit-logs':
            if not self.require_admin_authenticated():
                return

            action_filter = str((query.get('action', [''])[0] or '')).strip()
            status_filter = str((query.get('status', [''])[0] or '')).strip()
            keyword = str((query.get('keyword', [''])[0] or '')).strip()
            page = parse_positive_int((query.get('page', ['1'])[0] or '1'), 1, 1, 100000)
            page_size = parse_positive_int((query.get('page_size', ['20'])[0] or '20'), 20, 1, 100)

            conn = sqlite3.connect(db_path)
            c = conn.cursor()

            where_clauses = []
            where_values = []
            if action_filter:
                where_clauses.append('action = ?')
                where_values.append(action_filter)
            if status_filter:
                where_clauses.append('status = ?')
                where_values.append(status_filter)
            if keyword:
                where_clauses.append('(username LIKE ? OR client_ip LIKE ? OR detail LIKE ?)')
                like_value = f'%{keyword}%'
                where_values.extend([like_value, like_value, like_value])

            where_sql = (' WHERE ' + ' AND '.join(where_clauses)) if where_clauses else ''

            count_sql = f'SELECT COUNT(*) FROM admin_audit_logs{where_sql}'
            c.execute(count_sql, where_values)
            total = int(c.fetchone()[0] or 0)

            offset = (page - 1) * page_size
            query_sql = (
                'SELECT id, action, status, username, client_ip, detail, created_at '
                f'FROM admin_audit_logs{where_sql} '
                'ORDER BY id DESC LIMIT ? OFFSET ?'
            )
            c.execute(query_sql, [*where_values, page_size, offset])
            rows = c.fetchall()
            conn.close()

            logs = []
            for row in rows:
                logs.append({
                    'id': row[0],
                    'action': row[1],
                    'status': row[2],
                    'username': row[3],
                    'client_ip': row[4],
                    'detail': row[5],
                    'created_at': row[6]
                })

            total_pages = max(1, (total + page_size - 1) // page_size)
            self.send_json({
                'items': logs,
                'page': page,
                'page_size': page_size,
                'total': total,
                'total_pages': total_pages
            }, 200)

        elif request_path == '/api/admin-audit-logs/export':
            if not self.require_admin_authenticated():
                return

            action_filter = str((query.get('action', [''])[0] or '')).strip()
            status_filter = str((query.get('status', [''])[0] or '')).strip()
            keyword = str((query.get('keyword', [''])[0] or '')).strip()

            conn = sqlite3.connect(db_path)
            c = conn.cursor()

            where_clauses = []
            where_values = []
            if action_filter:
                where_clauses.append('action = ?')
                where_values.append(action_filter)
            if status_filter:
                where_clauses.append('status = ?')
                where_values.append(status_filter)
            if keyword:
                where_clauses.append('(username LIKE ? OR client_ip LIKE ? OR detail LIKE ?)')
                like_value = f'%{keyword}%'
                where_values.extend([like_value, like_value, like_value])

            where_sql = (' WHERE ' + ' AND '.join(where_clauses)) if where_clauses else ''
            c.execute(
                'SELECT id, action, status, username, client_ip, detail, created_at '
                f'FROM admin_audit_logs{where_sql} '
                'ORDER BY id DESC LIMIT 1000',
                where_values
            )
            rows = c.fetchall()
            conn.close()

            buffer = io.StringIO()
            writer = csv.writer(buffer)
            writer.writerow(['id', 'action', 'status', 'username', 'client_ip', 'detail', 'created_at'])
            for row in rows:
                writer.writerow(list(row))

            csv_content = buffer.getvalue()
            self.send_response(200)
            self.send_header('Content-type', 'text/csv; charset=utf-8')
            self.send_header('Content-Disposition', 'attachment; filename="admin-audit-logs.csv"')
            self.end_headers()
            self.wfile.write(csv_content.encode('utf-8-sig'))
        else:
            super().do_GET()
    
    def do_POST(self):
        if self.path == '/api/messages':
            data = self.read_json_body()
            
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute(
                'INSERT INTO messages (name, email, message) VALUES (?, ?, ?)',
                (data['name'], data['email'], data['message'])
            )
            new_id = c.lastrowid
            conn.commit()
            conn.close()
            
            self.send_response(201)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'id': new_id,
                'name': data['name'],
                'email': data['email'],
                'message': data['message']
            }).encode('utf-8'))

        elif self.path == '/api/contact':
            data = self.read_json_body()

            name = data.get('name', '').strip()
            email = data.get('email', '').strip()
            subject = data.get('subject', '').strip()
            message = data.get('message', '').strip()

            if not name or not email or not message:
                self.send_response(400)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'name, email and message are required'}).encode('utf-8'))
                return

            # messages 表结构无 subject 字段，按统一格式落库，保持兼容现有后台。
            merged_message = message if not subject else f"[主题] {subject}\n\n{message}"

            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute(
                'INSERT INTO messages (name, email, message) VALUES (?, ?, ?)',
                (name, email, merged_message)
            )
            new_id = c.lastrowid
            conn.commit()
            conn.close()

            self.send_response(201)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'success': True,
                'message': '消息发送成功，我们会尽快回复。',
                'id': new_id
            }).encode('utf-8'))
            
        elif self.path == '/api/links':
            data = self.read_json_body()
            
            # 处理前端发送的字段名格式
            site_name = data.get('site-name', data.get('site_name', ''))
            site_url = data.get('site-url', data.get('site_url', ''))
            site_description = data.get('site-description', data.get('site_description', ''))
            site_avatar = data.get('site-avatar', data.get('site_avatar', ''))

            if not site_name or not site_url or not site_description:
                self.send_json({'error': 'site_name, site_url and site_description are required'}, 400)
                return

            if not is_valid_http_url(site_url):
                self.send_json({'error': 'site_url must be a valid http/https url'}, 400)
                return

            # 限制头像体积（约 1MB），避免本地 SQLite 被超大 Base64 撑爆。
            if site_avatar and len(site_avatar) > 1_000_000:
                self.send_response(400)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': '头像文件过大，请控制在 1MB 以内'}).encode('utf-8'))
                return
            
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute(
                'INSERT INTO links (site_name, site_url, site_description, site_avatar) VALUES (?, ?, ?, ?)',
                (site_name, site_url, site_description, site_avatar)
            )
            new_id = c.lastrowid
            conn.commit()
            conn.close()
            
            self.send_response(201)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'id': new_id,
                'site_name': site_name,
                'site_url': site_url,
                'site_description': site_description,
                'site_avatar': site_avatar,
                'status': 'pending'
            }).encode('utf-8'))
            
        elif self.path == '/api/articles':
            if not self.require_admin_authenticated():
                return
            if not self.require_admin_csrf():
                return

            data = self.read_json_body()

            if not data.get('title') or not data.get('content') or not data.get('category'):
                self.send_json({'error': 'title, content and category are required'}, 400)
                return
            
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute(
                'INSERT INTO articles (title, content, category) VALUES (?, ?, ?)',
                (data['title'], data['content'], data['category'])
            )
            new_id = c.lastrowid
            conn.commit()
            conn.close()
            
            self.send_response(201)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'id': new_id,
                'title': data['title'],
                'content': data['content'],
                'category': data['category']
            }).encode('utf-8'))
            write_admin_audit_log(
                action='article_create',
                status='success',
                username=self.get_active_session().get('username', '') if self.get_active_session() else '',
                client_ip=self.get_client_ip(),
                detail=f'article_id={new_id}'
            )
            
        elif self.path == '/api/login':
            data = self.read_json_body()

            admin_credentials = get_admin_credentials()
            username = str(data.get('username', ''))
            password = str(data.get('password', ''))
            client_id = get_client_identifier(self)

            retry_after = check_login_lock(client_id)
            if retry_after > 0:
                write_admin_audit_log(
                    action='admin_login',
                    status='blocked',
                    username=username,
                    client_ip=client_id,
                    detail=f'retry_after={retry_after}'
                )
                self.send_json({
                    'success': False,
                    'message': '登录失败次数过多，请稍后再试',
                    'retry_after_seconds': retry_after
                }, 429)
                return

            is_valid = (
                username == admin_credentials['username']
                and verify_password(
                    password,
                    admin_credentials.get('password_salt', ''),
                    admin_credentials.get('password_hash', ''),
                    admin_credentials.get('password_iterations', PASSWORD_HASH_ITERATIONS)
                )
            )

            if is_valid:
                clear_login_failures(client_id)
                response = {'success': True, 'message': 'Login successful'}
                session_id, csrf_token = self.create_admin_session(admin_credentials['username'])
                response['csrf_token'] = csrf_token
                response['username'] = admin_credentials['username']
                write_admin_audit_log(
                    action='admin_login',
                    status='success',
                    username=admin_credentials['username'],
                    client_ip=client_id,
                    detail='login_ok'
                )
                self.send_json(response, 200, {
                    'Set-Cookie': f'{SESSION_COOKIE_NAME}={session_id}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}'
                })
            else:
                record_login_failure(client_id)
                write_admin_audit_log(
                    action='admin_login',
                    status='failed',
                    username=username,
                    client_ip=client_id,
                    detail='invalid_credentials'
                )
                response = {'success': False, 'message': 'Invalid credentials'}
                self.send_json(response, 401)

        elif self.path == '/api/logout':
            if not self.require_admin_authenticated():
                return
            if not self.require_admin_csrf():
                return

            active_session = self.get_active_session() or {}
            self.clear_admin_session()
            write_admin_audit_log(
                action='admin_logout',
                status='success',
                username=active_session.get('username', ''),
                client_ip=self.get_client_ip(),
                detail='logout_ok'
            )
            self.send_json({'success': True, 'message': 'Logged out'}, 200, {
                'Set-Cookie': f'{SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
            })
        
        elif self.path == '/api/change-password':
            if not self.require_admin_authenticated():
                return
            if not self.require_admin_csrf():
                return

            data = self.read_json_body()

            admin_credentials = get_admin_credentials()

            # 验证当前密码
            if not verify_password(
                str(data.get('current_password', '')),
                admin_credentials.get('password_salt', ''),
                admin_credentials.get('password_hash', ''),
                admin_credentials.get('password_iterations', PASSWORD_HASH_ITERATIONS)
            ):
                active_session = self.get_active_session() or {}
                write_admin_audit_log(
                    action='credentials_change',
                    status='failed',
                    username=active_session.get('username', ''),
                    client_ip=self.get_client_ip(),
                    detail='current_password_incorrect'
                )
                response = {'success': False, 'message': 'Current password is incorrect'}
                self.send_json(response, 401)
            else:
                raw_new_username = data.get('new_username')
                raw_new_password = data.get('new_password')

                new_username = str(raw_new_username).strip() if raw_new_username is not None else ''
                new_password = str(raw_new_password).strip() if raw_new_password is not None else ''

                if raw_new_username is not None and not new_username:
                    response = {'success': False, 'message': 'New username cannot be empty'}
                    self.send_json(response, 400)
                elif raw_new_password is not None and not new_password:
                    response = {'success': False, 'message': 'New password cannot be empty'}
                    self.send_json(response, 400)
                elif not new_username and not new_password:
                    response = {'success': False, 'message': 'No updates were provided'}
                    self.send_json(response, 400)
                else:
                    final_username = new_username or admin_credentials['username']
                    final_password_hash = {
                        'password_salt': admin_credentials.get('password_salt', ''),
                        'password_hash': admin_credentials.get('password_hash', ''),
                        'password_iterations': admin_credentials.get('password_iterations', PASSWORD_HASH_ITERATIONS)
                    }
                    if new_password:
                        final_password_hash = hash_password(new_password)

                    save_admin_credentials(final_username, final_password_hash)
                    response = {
                        'success': True,
                        'message': 'Credentials updated successfully',
                        'username': final_username
                    }
                    active_session = self.get_active_session() or {}
                    write_admin_audit_log(
                        action='credentials_change',
                        status='success',
                        username=active_session.get('username', ''),
                        client_ip=self.get_client_ip(),
                        detail=f'new_username={final_username}'
                    )
                    self.send_json(response, 200)

        elif self.path == '/api/reset-admin-credentials':
            if not self.is_local_request():
                write_admin_audit_log(
                    action='credentials_reset',
                    status='denied',
                    username='',
                    client_ip=self.get_client_ip(),
                    detail='non_local_request'
                )
                self.send_response(403)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'message': 'Only localhost is allowed'}).encode('utf-8'))
                return

            if not self.require_admin_authenticated():
                return
            if not self.require_admin_csrf():
                return

            content_length = int(self.headers.get('Content-Length', 0) or 0)
            post_data = self.rfile.read(content_length) if content_length > 0 else b'{}'

            try:
                data = json.loads(post_data.decode('utf-8')) if post_data else {}
            except (json.JSONDecodeError, UnicodeDecodeError):
                data = {}

            if str(data.get('confirm_text', '')).strip() != 'RESET_ADMIN':
                active_session = self.get_active_session() or {}
                write_admin_audit_log(
                    action='credentials_reset',
                    status='failed',
                    username=active_session.get('username', ''),
                    client_ip=self.get_client_ip(),
                    detail='invalid_confirmation_text'
                )
                self.send_response(400)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'message': 'Invalid confirmation text'}).encode('utf-8'))
                return

            save_admin_credentials('admin', hash_password('admin'))
            active_session = self.get_active_session() or {}
            write_admin_audit_log(
                action='credentials_reset',
                status='success',
                username=active_session.get('username', ''),
                client_ip=self.get_client_ip(),
                detail='reset_to_default'
            )
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'success': True,
                'message': 'Credentials reset to default',
                'username': 'admin'
            }).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_PUT(self):
        normalized_path = self.path.rstrip('/')

        if normalized_path.startswith('/api/links/'):
            if not self.require_admin_authenticated():
                return
            if not self.require_admin_csrf():
                return

            # 处理友链审核
            link_id = normalized_path.split('/')[-1]
            data = self.read_json_body()

            if data.get('status') not in ('pending', 'approved', 'rejected'):
                self.send_json({'error': 'invalid status'}, 400)
                return
            
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute(
                'UPDATE links SET status = ? WHERE id = ?',
                (data['status'], link_id)
            )
            conn.commit()
            conn.close()
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'id': link_id, 'status': data['status']}).encode('utf-8'))
            active_session = self.get_active_session() or {}
            write_admin_audit_log(
                action='link_status_update',
                status='success',
                username=active_session.get('username', ''),
                client_ip=self.get_client_ip(),
                detail=f'link_id={link_id},status={data["status"]}'
            )
            
        elif normalized_path.startswith('/api/articles/'):
            if not self.require_admin_authenticated():
                return
            if not self.require_admin_csrf():
                return

            # 处理文章编辑
            article_id = normalized_path.split('/')[-1]
            data = self.read_json_body()

            if not data.get('title') or not data.get('content') or not data.get('category'):
                self.send_json({'error': 'title, content and category are required'}, 400)
                return
            
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute(
                'UPDATE articles SET title = ?, content = ?, category = ? WHERE id = ?',
                (data['title'], data['content'], data['category'], article_id)
            )
            conn.commit()
            conn.close()
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
            active_session = self.get_active_session() or {}
            write_admin_audit_log(
                action='article_update',
                status='success',
                username=active_session.get('username', ''),
                client_ip=self.get_client_ip(),
                detail=f'article_id={article_id}'
            )
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_DELETE(self):
        normalized_path = self.path.rstrip('/')

        if normalized_path.startswith('/api/messages/'):
            if not self.require_admin_authenticated():
                return
            if not self.require_admin_csrf():
                return

            # 处理留言删除
            message_id = normalized_path.split('/')[-1]
            
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute('DELETE FROM messages WHERE id = ?', (message_id,))
            conn.commit()
            conn.close()
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'id': message_id, 'deleted': True}).encode('utf-8'))
            active_session = self.get_active_session() or {}
            write_admin_audit_log(
                action='message_delete',
                status='success',
                username=active_session.get('username', ''),
                client_ip=self.get_client_ip(),
                detail=f'message_id={message_id}'
            )
            
        elif normalized_path.startswith('/api/links/'):
            if not self.require_admin_authenticated():
                return
            if not self.require_admin_csrf():
                return

            # 处理友链删除
            link_id = normalized_path.split('/')[-1]
            
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute('DELETE FROM links WHERE id = ?', (link_id,))
            conn.commit()
            conn.close()
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'id': link_id, 'deleted': True}).encode('utf-8'))
            active_session = self.get_active_session() or {}
            write_admin_audit_log(
                action='link_delete',
                status='success',
                username=active_session.get('username', ''),
                client_ip=self.get_client_ip(),
                detail=f'link_id={link_id}'
            )
            
        elif normalized_path.startswith('/api/articles/'):
            if not self.require_admin_authenticated():
                return
            if not self.require_admin_csrf():
                return

            # 处理文章删除
            article_id = normalized_path.split('/')[-1]
            
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute('DELETE FROM articles WHERE id = ?', (article_id,))
            conn.commit()
            conn.close()
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'id': article_id, 'deleted': True}).encode('utf-8'))
            active_session = self.get_active_session() or {}
            write_admin_audit_log(
                action='article_delete',
                status='success',
                username=active_session.get('username', ''),
                client_ip=self.get_client_ip(),
                detail=f'article_id={article_id}'
            )
        else:
            self.send_response(404)
            self.end_headers()

# 启动服务器
ensure_database_schema()
with socketserver.TCPServer(("", PORT), MyHTTPRequestHandler) as httpd:
    print(f"服务器运行在 http://localhost:{PORT}")
    httpd.serve_forever()
