/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use core_model::*;
use core_store::{Store, StoreError};

struct TestEnv(u64);

impl Env for TestEnv {
    fn now_ms(&self) -> i64 {
        5_000 + self.0 as i64
    }

    fn new_id(&mut self) -> String {
        self.0 += 1;
        format!("n{:04}", self.0)
    }
}

fn model() -> Model {
    Model::new(Box::new(TestEnv(0)), "dev")
}

fn reload(store: &Store) -> Model {
    store.load(Box::new(TestEnv(1000)), "dev").unwrap()
}

fn same(a: &Model, b: &Model) {
    assert_eq!(a.identities(), b.identities());
    assert_eq!(a.spaces(), b.spaces());
    assert_eq!(a.nodes(), b.nodes());
}

#[test]
fn fresh_database_is_migrated_and_reopening_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.schema_version().unwrap(), 4);
    drop(store);
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.schema_version().unwrap(), 4);
    let empty = reload(&store);
    assert!(empty.spaces().is_empty());
}

#[test]
fn a_newer_database_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let conn = rusqlite::Connection::open(dir.path().join("sidebar.db")).unwrap();
    conn.pragma_update(None, "user_version", 99).unwrap();
    drop(conn);
    assert!(matches!(
        Store::open(dir.path()),
        Err(StoreError::Schema(_))
    ));
}

#[test]
fn save_all_then_load_round_trips_including_order_and_unicode() {
    let mut m = model();
    let a = m
        .create_space("Arbeit \u{1f4bc}", Icon::Emoji("\u{1f4bc}".into()), None)
        .unwrap();
    let b = m
        .create_space("B", Icon::Symbol("star".into()), None)
        .unwrap();
    let pinned = m.space(&a).unwrap().pinned_root.clone();
    let (folder, _) = m
        .insert_folder(&pinned, 0, "Dossier \u{e9}t\u{e9}")
        .unwrap();
    m.insert_tab(&folder, 0, "https://a.test/\u{4e2d}", "\u{4e2d}\u{6587}")
        .unwrap();
    m.insert_tab(&pinned, 1, "https://b.test/", "b").unwrap();
    m.insert_tab(&pinned, 0, "https://c.test/", "c").unwrap();
    let mut store = Store::open_in_memory().unwrap();
    store.save_all(&m).unwrap();
    let loaded = reload(&store);
    same(&m, &loaded);
    assert_eq!(loaded.spaces()[0].id, a);
    assert_eq!(loaded.spaces()[1].id, b);
}

#[test]
fn applying_ops_keeps_the_database_equal_to_the_model() {
    let mut m = model();
    let mut store = Store::open_in_memory().unwrap();
    let s = m
        .create_space("A", Icon::Symbol("star".into()), None)
        .unwrap();
    store.sync_structure(&m).unwrap();
    let pinned = m.space(&s).unwrap().pinned_root.clone();
    let today = m.space(&s).unwrap().today_root.clone();

    let (folder, ops) = m.insert_folder(&pinned, 0, "F").unwrap();
    store.apply(&m, &ops).unwrap();
    let (t1, ops) = m.insert_tab(&folder, 0, "https://1.test/", "1").unwrap();
    store.apply(&m, &ops).unwrap();
    let (t2, ops) = m.insert_tab(&pinned, 1, "https://2.test/", "2").unwrap();
    store.apply(&m, &ops).unwrap();
    let (t3, ops) = m.insert_tab(&today, 0, "https://3.test/", "3").unwrap();
    store.apply(&m, &ops).unwrap();
    same(&m, &reload(&store));

    let ops = m.move_node(&t2, &folder, 0).unwrap();
    store.apply(&m, &ops).unwrap();
    let ops = m.move_node(&t3, &pinned, 1).unwrap();
    store.apply(&m, &ops).unwrap();
    let ops = m.rename_node(&folder, "Renamed").unwrap();
    store.apply(&m, &ops).unwrap();
    let ops = m.set_collapsed(&folder, true).unwrap();
    store.apply(&m, &ops).unwrap();
    same(&m, &reload(&store));

    let (ops, _) = m.remove_node(&folder).unwrap();
    store.apply(&m, &ops).unwrap();
    let loaded = reload(&store);
    same(&m, &loaded);
    assert!(loaded.node(&t1).is_none());
    assert!(loaded.node(&t2).is_none());
    assert!(loaded.node(&t3).is_some());
}

#[test]
fn a_failing_op_rolls_the_whole_batch_back() {
    let mut m = model();
    let mut store = Store::open_in_memory().unwrap();
    let s = m
        .create_space("A", Icon::Symbol("star".into()), None)
        .unwrap();
    store.sync_structure(&m).unwrap();
    let pinned = m.space(&s).unwrap().pinned_root.clone();
    let (_, mut ops) = m.insert_tab(&pinned, 0, "https://1.test/", "1").unwrap();
    let TreeOp::Inserted {
        mut node, index, ..
    } = ops[0].clone()
    else {
        unreachable!()
    };
    node.id = NodeId::from("orphan");
    node.parent_id = Some(NodeId::from("does-not-exist"));
    ops.push(TreeOp::Inserted {
        node,
        parent: NodeId::from("does-not-exist"),
        index,
    });
    assert!(store.apply(&m, &ops).is_err());
    let loaded = reload(&store);
    assert_eq!(loaded.nodes().len(), 3, "only the three roots survive");
}

#[test]
fn loading_a_corrupted_tree_fails_the_invariant_check() {
    let dir = tempfile::tempdir().unwrap();
    let mut m = model();
    let s = m
        .create_space("A", Icon::Symbol("star".into()), None)
        .unwrap();
    let pinned = m.space(&s).unwrap().pinned_root.clone();
    let today = m.space(&s).unwrap().today_root.clone();
    let (folder, _) = m.insert_folder(&pinned, 0, "F").unwrap();
    {
        let mut store = Store::open(dir.path()).unwrap();
        store.save_all(&m).unwrap();
    }
    let conn = rusqlite::Connection::open(dir.path().join("sidebar.db")).unwrap();
    conn.execute(
        "UPDATE nodes SET parent_id = ?1 WHERE id = ?2",
        rusqlite::params![today.as_str(), folder.as_str()],
    )
    .unwrap();
    drop(conn);
    let store = Store::open(dir.path()).unwrap();
    let result = store.load(Box::new(TestEnv(1000)), "dev");
    assert!(matches!(
        result,
        Err(StoreError::Model(ModelError::Invariant(_)))
    ));
}

#[test]
fn state_survives_reopening_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut m = model();
    let s = m
        .create_space("A", Icon::Symbol("star".into()), None)
        .unwrap();
    m.insert_tab(
        &m.space(&s).unwrap().pinned_root.clone(),
        0,
        "https://a.test/",
        "a",
    )
    .unwrap();
    {
        let mut store = Store::open(dir.path()).unwrap();
        store.save_all(&m).unwrap();
        store.set_meta("last_space", s.as_str()).unwrap();
    }
    let store = Store::open(dir.path()).unwrap();
    same(&m, &reload(&store));
    assert_eq!(
        store.get_meta("last_space").unwrap().as_deref(),
        Some(s.as_str())
    );
    assert_eq!(store.get_meta("missing").unwrap(), None);
}

#[test]
fn site_zoom_is_kept_per_identity_and_host() {
    let mut m = model();
    let a = m
        .create_space("A", Icon::Symbol("star".into()), None)
        .unwrap();
    let b = m
        .create_space("B", Icon::Symbol("star".into()), None)
        .unwrap();
    let identity_a = m.identity_of_space(&a).unwrap().id.0.clone();
    let identity_b = m.identity_of_space(&b).unwrap().id.0.clone();
    assert_ne!(identity_a, identity_b);
    let mut store = Store::open_in_memory().unwrap();
    store.save_all(&m).unwrap();

    assert_eq!(store.site_zoom(&identity_a, "example.com").unwrap(), None);
    store
        .set_site_zoom(&identity_a, "example.com", Some(1.5))
        .unwrap();
    assert_eq!(
        store.site_zoom(&identity_a, "example.com").unwrap(),
        Some(1.5)
    );
    assert_eq!(store.site_zoom(&identity_b, "example.com").unwrap(), None);
    assert_eq!(store.site_zoom(&identity_a, "other.test").unwrap(), None);

    store
        .set_site_zoom(&identity_a, "example.com", Some(0.8))
        .unwrap();
    assert_eq!(
        store.site_zoom(&identity_a, "example.com").unwrap(),
        Some(0.8)
    );
    store
        .set_site_zoom(&identity_a, "example.com", None)
        .unwrap();
    assert_eq!(store.site_zoom(&identity_a, "example.com").unwrap(), None);
}
