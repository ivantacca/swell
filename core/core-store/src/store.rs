/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::error::{Result, StoreError};
use core_model::{Env, Icon, Identity, Model, Node, NodeId, NodeKind, Space, TreeOp};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

const DB_FILE: &str = "sidebar.db";

/// Each entry upgrades the schema by one version; `PRAGMA user_version` is the
/// number of entries already applied.
const MIGRATIONS: &[&str] = &[
    "
    CREATE TABLE identities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        gecko_user_context_id INTEGER NOT NULL UNIQUE,
        profile_dir_key TEXT NOT NULL
    );
    CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        icon TEXT NOT NULL,
        identity_id TEXT NOT NULL REFERENCES identities(id),
        pinned_root TEXT NOT NULL,
        today_root TEXT NOT NULL,
        position INTEGER NOT NULL
    );
    CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by_device TEXT NOT NULL,
        kind TEXT NOT NULL
    );
    CREATE INDEX nodes_by_parent ON nodes(parent_id, position);
    CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
",
    "
    CREATE TABLE site_zoom (
        identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
        host TEXT NOT NULL,
        factor REAL NOT NULL,
        PRIMARY KEY (identity_id, host)
    );
",
    "ALTER TABLE spaces ADD COLUMN tint TEXT;",
    "ALTER TABLE spaces ADD COLUMN pinned_collapsed INTEGER NOT NULL DEFAULT 0;",
];

pub struct Store {
    conn: Connection,
}

impl Store {
    /// Opens (creating if needed) `sidebar.db` under `dir` and migrates it.
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        Self::from_connection(Connection::open(dir.join(DB_FILE))?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", true)?;
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        let mut store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    pub fn schema_version(&self) -> Result<usize> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        Ok(version as usize)
    }

    fn migrate(&mut self) -> Result<()> {
        let current = self.schema_version()?;
        if current > MIGRATIONS.len() {
            return Err(StoreError::Schema(format!(
                "database is version {current}, this build understands up to {}",
                MIGRATIONS.len()
            )));
        }
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(current) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (index + 1) as i64)?;
            tx.commit()?;
        }
        Ok(())
    }

    /// The saved page zoom of `host` for one identity, if it is not the default.
    pub fn site_zoom(&self, identity: &str, host: &str) -> Result<Option<f64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT factor FROM site_zoom WHERE identity_id = ?1 AND host = ?2",
                params![identity, host],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Saves the zoom of `host` for one identity; `None` goes back to the default.
    pub fn set_site_zoom(&self, identity: &str, host: &str, factor: Option<f64>) -> Result<()> {
        match factor {
            Some(factor) => self.conn.execute(
                "INSERT INTO site_zoom (identity_id, host, factor) VALUES (?1, ?2, ?3)
                 ON CONFLICT (identity_id, host) DO UPDATE SET factor = excluded.factor",
                params![identity, host, factor],
            )?,
            None => self.conn.execute(
                "DELETE FROM site_zoom WHERE identity_id = ?1 AND host = ?2",
                params![identity, host],
            )?,
        };
        Ok(())
    }

    /// Reads everything back into a model and checks every invariant.
    pub fn load(&self, env: Box<dyn Env>, device: &str) -> Result<Model> {
        let identities = self
            .conn
            .prepare(
                "SELECT id, name, gecko_user_context_id, profile_dir_key FROM identities ORDER BY id",
            )?
            .query_map([], |row| {
                Ok(Identity {
                    id: row.get::<_, String>(0)?.into(),
                    name: row.get(1)?,
                    gecko_user_context_id: row.get(2)?,
                    profile_dir_key: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let mut spaces = Vec::new();
        let mut stmt = self.conn.prepare(
            "SELECT id, title, icon, identity_id, pinned_root, today_root, tint, pinned_collapsed FROM spaces ORDER BY position",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let icon: Icon = serde_json::from_str(&row.get::<_, String>(2)?)?;
            spaces.push(Space {
                id: row.get::<_, String>(0)?.into(),
                title: row.get(1)?,
                icon,
                tint: row.get(6)?,
                pinned_collapsed: row.get(7)?,
                identity_id: row.get::<_, String>(3)?.into(),
                pinned_root: row.get::<_, String>(4)?.into(),
                today_root: row.get::<_, String>(5)?.into(),
            });
        }

        let mut nodes: Vec<Node> = Vec::new();
        let mut stmt = self.conn.prepare(
            "SELECT id, parent_id, created_at, updated_at, updated_by_device, kind
             FROM nodes ORDER BY parent_id, position",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let kind: NodeKind = serde_json::from_str(&row.get::<_, String>(5)?)?;
            nodes.push(Node {
                id: row.get::<_, String>(0)?.into(),
                parent_id: row.get::<_, Option<String>>(1)?.map(Into::into),
                children: Vec::new(),
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                updated_by_device: row.get(4)?,
                kind,
            });
        }
        let mut children: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
        for node in &nodes {
            if let Some(parent) = &node.parent_id {
                children
                    .entry(parent.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }
        for node in &mut nodes {
            node.children = children.remove(&node.id).unwrap_or_default();
        }
        Ok(Model::from_parts(env, device, identities, spaces, nodes)?)
    }

    /// Writes the whole model, replacing whatever was stored.
    pub fn save_all(&mut self, model: &Model) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        tx.execute("DELETE FROM spaces", [])?;
        tx.execute("DELETE FROM nodes", [])?;
        tx.execute("DELETE FROM identities", [])?;
        write_structure(&tx, model)?;
        for node in model.nodes() {
            insert_node(&tx, &node, 0)?;
        }
        for node in model.nodes() {
            reposition(&tx, &node)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Upserts identities, spaces and root nodes; call after creating either.
    pub fn sync_structure(&mut self, model: &Model) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        write_structure(&tx, model)?;
        for node in model.nodes() {
            if matches!(node.kind, NodeKind::Root(_)) {
                insert_node(&tx, &node, 0)?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Makes the store match a model that lost spaces: forgets the spaces,
    /// identities and nodes the model no longer has, then writes the order.
    pub fn sync_removals(&mut self, model: &Model) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        let spaces: BTreeSet<String> = model
            .spaces()
            .iter()
            .map(|space| space.id.0.clone())
            .collect();
        let identities: BTreeSet<String> = model
            .identities()
            .iter()
            .map(|identity| identity.id.0.clone())
            .collect();
        let nodes: BTreeSet<String> = model.nodes().iter().map(|node| node.id.0.clone()).collect();
        for (table, keep) in [
            ("spaces", &spaces),
            ("nodes", &nodes),
            ("identities", &identities),
        ] {
            let stored: Vec<String> = tx
                .prepare(&format!("SELECT id FROM {table}"))?
                .query_map([], |row| row.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            for id in stored.into_iter().filter(|id| !keep.contains(id)) {
                tx.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])?;
            }
        }
        write_structure(&tx, model)?;
        tx.commit()?;
        Ok(())
    }

    /// Persists tree ops that were just applied to `model`, atomically: either
    /// every op lands or none does.
    pub fn apply(&mut self, model: &Model, ops: &[TreeOp]) -> Result<()> {
        let tx = self.conn.transaction()?;
        let mut touched: BTreeSet<NodeId> = BTreeSet::new();
        for op in ops {
            match op {
                TreeOp::Inserted { node, parent, .. } => {
                    insert_node(&tx, node, 0)?;
                    touched.insert(parent.clone());
                }
                TreeOp::Moved { id, parent, .. } => {
                    if let Some(old) = parent_of(&tx, id)? {
                        touched.insert(old.into());
                    }
                    let (updated_at, device) = model
                        .node(id)
                        .map(|n| (n.updated_at, n.updated_by_device.clone()))
                        .unwrap_or_default();
                    tx.execute(
                        "UPDATE nodes SET parent_id = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                        params![parent.as_str(), updated_at, device, id.as_str()],
                    )?;
                    touched.insert(parent.clone());
                }
                TreeOp::Removed { id } => {
                    if let Some(old) = parent_of(&tx, id)? {
                        touched.insert(old.into());
                    }
                    tx.execute("DELETE FROM nodes WHERE id = ?1", params![id.as_str()])?;
                }
                TreeOp::Updated { node } => {
                    tx.execute(
                        "UPDATE nodes SET kind = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                        params![
                            serde_json::to_string(&node.kind)?,
                            node.updated_at,
                            node.updated_by_device,
                            node.id.as_str()
                        ],
                    )?;
                }
            }
        }
        for parent in touched {
            if let Some(node) = model.node(&parent) {
                reposition(&tx, node)?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn set_meta(&mut self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

fn write_structure(tx: &Transaction, model: &Model) -> Result<()> {
    for identity in model.identities() {
        tx.execute(
            "INSERT INTO identities (id, name, gecko_user_context_id, profile_dir_key)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name,
               gecko_user_context_id = excluded.gecko_user_context_id,
               profile_dir_key = excluded.profile_dir_key",
            params![
                identity.id.as_str(),
                identity.name,
                identity.gecko_user_context_id,
                identity.profile_dir_key
            ],
        )?;
    }
    for (position, space) in model.spaces().iter().enumerate() {
        tx.execute(
            "INSERT INTO spaces (id, title, icon, identity_id, pinned_root, today_root, position, tint, pinned_collapsed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, icon = excluded.icon,
               identity_id = excluded.identity_id, pinned_root = excluded.pinned_root,
               today_root = excluded.today_root, position = excluded.position,
               tint = excluded.tint, pinned_collapsed = excluded.pinned_collapsed",
            params![
                space.id.as_str(),
                space.title,
                serde_json::to_string(&space.icon)?,
                space.identity_id.as_str(),
                space.pinned_root.as_str(),
                space.today_root.as_str(),
                position as i64,
                space.tint,
                space.pinned_collapsed
            ],
        )?;
    }
    Ok(())
}

fn insert_node(tx: &Transaction, node: &Node, position: i64) -> Result<()> {
    tx.execute(
        "INSERT INTO nodes (id, parent_id, position, created_at, updated_at, updated_by_device, kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id,
           updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device,
           kind = excluded.kind",
        params![
            node.id.as_str(),
            node.parent_id.as_ref().map(NodeId::as_str),
            position,
            node.created_at,
            node.updated_at,
            node.updated_by_device,
            serde_json::to_string(&node.kind)?
        ],
    )?;
    Ok(())
}

fn reposition(tx: &Transaction, parent: &Node) -> Result<()> {
    for (position, child) in parent.children.iter().enumerate() {
        tx.execute(
            "UPDATE nodes SET position = ?1 WHERE id = ?2",
            params![position as i64, child.as_str()],
        )?;
    }
    Ok(())
}

fn parent_of(tx: &Transaction, id: &NodeId) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT parent_id FROM nodes WHERE id = ?1",
            params![id.as_str()],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}
