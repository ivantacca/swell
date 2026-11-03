/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use core_ffi::*;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<String>>,
    diffs: Mutex<Vec<TreeDiff>>,
    opened: Mutex<Vec<(String, u32, String, String)>>,
    nodes: Mutex<Vec<String>>,
}

impl Recorder {
    fn log(&self, event: String) {
        self.events.lock().unwrap().push(event);
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }
}

impl CoreListener for Recorder {
    fn on_tree_changed(&self, diff: TreeDiff) {
        self.log(format!("tree:{}", diff.ops.len()));
        self.diffs.lock().unwrap().push(diff);
    }

    fn on_spaces_changed(&self, spaces: Vec<SpaceView>) {
        self.log(format!("spaces:{}", spaces.len()));
    }

    fn on_active_space_changed(&self, _window: String, space: String) {
        self.log(format!("active:{space}"));
    }

    fn on_open_tab(
        &self,
        window: String,
        space: String,
        user_context_id: u32,
        url: String,
        live_tab: String,
        node: String,
    ) {
        self.log(format!("open:{live_tab}"));
        self.opened
            .lock()
            .unwrap()
            .push((window, user_context_id, url, space));
        self.nodes.lock().unwrap().push(node);
    }

    fn on_select_tab(&self, _window: String, live_tab: String) {
        self.log(format!("select:{live_tab}"));
    }

    fn on_close_tab(&self, _window: String, live_tab: String) {
        self.log(format!("close:{live_tab}"));
    }
}

struct Forward(Arc<Recorder>);

impl CoreListener for Forward {
    fn on_tree_changed(&self, diff: TreeDiff) {
        self.0.on_tree_changed(diff)
    }

    fn on_spaces_changed(&self, spaces: Vec<SpaceView>) {
        self.0.on_spaces_changed(spaces)
    }

    fn on_active_space_changed(&self, window: String, space: String) {
        self.0.on_active_space_changed(window, space)
    }

    fn on_open_tab(
        &self,
        window: String,
        space: String,
        user_context_id: u32,
        url: String,
        live_tab: String,
        node: String,
    ) {
        self.0
            .on_open_tab(window, space, user_context_id, url, live_tab, node)
    }

    fn on_select_tab(&self, window: String, live_tab: String) {
        self.0.on_select_tab(window, live_tab)
    }

    fn on_close_tab(&self, window: String, live_tab: String) {
        self.0.on_close_tab(window, live_tab)
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    core: Arc<SwellCore>,
    recorder: Arc<Recorder>,
}

fn open(dir: tempfile::TempDir) -> Fixture {
    let core = SwellCore::open(dir.path().to_string_lossy().into_owned()).unwrap();
    let recorder = Arc::new(Recorder::default());
    core.add_listener(Box::new(Forward(recorder.clone())));
    Fixture {
        dir,
        core,
        recorder,
    }
}

fn fixture() -> Fixture {
    open(tempfile::tempdir().unwrap())
}

fn reopen(f: Fixture) -> Fixture {
    let Fixture { dir, core, .. } = f;
    drop(core);
    open(dir)
}

fn first_space(core: &SwellCore) -> SpaceView {
    core.list_spaces().unwrap().remove(0)
}

fn snapshot_ids(core: &SwellCore, root: &str, space: &str) -> Vec<String> {
    let tree = core.space_tree(space.into()).unwrap();
    tree.children
        .iter()
        .find(|c| c.parent == root)
        .unwrap()
        .ids
        .clone()
}

#[test]
fn first_run_creates_one_personal_space_with_a_nonzero_container() {
    let f = fixture();
    let spaces = f.core.list_spaces().unwrap();
    assert_eq!(spaces.len(), 1);
    assert_eq!(spaces[0].title, "Personal");
    assert_ne!(spaces[0].user_context_id, 0);
    assert_eq!(
        f.core.last_active_space().unwrap().as_deref(),
        Some(spaces[0].id.as_str())
    );
    let f = reopen(f);
    assert_eq!(
        f.core.list_spaces().unwrap(),
        spaces,
        "second run keeps the same space"
    );
}

#[test]
fn two_spaces_have_distinct_containers() {
    let f = fixture();
    let b = f
        .core
        .create_space("Work".into(), Icon::Emoji { glyph: "W".into() })
        .unwrap();
    let spaces = f.core.list_spaces().unwrap();
    assert_eq!(spaces.len(), 2);
    assert_ne!(spaces[0].user_context_id, spaces[1].user_context_id);
    assert_eq!(spaces[1].id, b);
    assert!(f.recorder.events().contains(&"spaces:2".to_owned()));
}

#[test]
fn open_url_asks_the_bridge_for_a_tab_in_the_spaces_container() {
    let f = fixture();
    let a = first_space(&f.core);
    let b_id = f
        .core
        .create_space("Work".into(), Icon::Symbol { name: "x".into() })
        .unwrap();
    let b = f
        .core
        .list_spaces()
        .unwrap()
        .into_iter()
        .find(|s| s.id == b_id)
        .unwrap();
    f.core.open_window("w1".into()).unwrap();
    let live_a = f
        .core
        .open_url("w1".into(), a.id.clone(), "https://a.test/".into())
        .unwrap();
    let live_b = f
        .core
        .open_url("w1".into(), b.id.clone(), "https://b.test/".into())
        .unwrap();
    assert_ne!(live_a, live_b);
    let opened = f.recorder.opened.lock().unwrap().clone();
    assert_eq!(
        opened[0],
        (
            "w1".into(),
            a.user_context_id,
            "https://a.test/".into(),
            a.id.clone()
        )
    );
    let nodes = f.recorder.nodes.lock().unwrap().clone();
    assert_eq!(
        nodes[0],
        snapshot_ids(&f.core, &a.today_root, &a.id)[0],
        "the event names the node"
    );
    assert_eq!(
        opened[1],
        (
            "w1".into(),
            b.user_context_id,
            "https://b.test/".into(),
            b.id.clone()
        )
    );
    assert_ne!(opened[0].1, opened[1].1);
    assert_eq!(snapshot_ids(&f.core, &a.today_root, &a.id).len(), 1);
    assert_eq!(snapshot_ids(&f.core, &b.today_root, &b.id).len(), 1);
}

#[test]
fn navigation_pin_and_close_follow_the_rules_and_persist() {
    let f = fixture();
    let space = first_space(&f.core);
    f.core.open_window("w1".into()).unwrap();
    let live = f
        .core
        .open_url("w1".into(), space.id.clone(), "https://a.test/".into())
        .unwrap();
    f.core
        .on_navigation(
            live.clone(),
            "https://a.test/next".into(),
            "Next".into(),
            Transition::Link,
        )
        .unwrap();
    f.core
        .pin_tab("w1".into(), live.clone(), space.pinned_root.clone(), 0)
        .unwrap();
    assert_eq!(snapshot_ids(&f.core, &space.today_root, &space.id).len(), 0);
    let pinned = snapshot_ids(&f.core, &space.pinned_root, &space.id);
    assert_eq!(pinned.len(), 1);

    f.core.on_tab_closed(live).unwrap();
    assert_eq!(
        snapshot_ids(&f.core, &space.pinned_root, &space.id),
        pinned,
        "a pinned node stays"
    );

    let live2 = f
        .core
        .open_url("w1".into(), space.id.clone(), "https://b.test/".into())
        .unwrap();
    f.core.on_tab_closed(live2).unwrap();
    assert_eq!(
        snapshot_ids(&f.core, &space.today_root, &space.id).len(),
        0,
        "a Today node goes"
    );

    let f = reopen(f);
    let tree = f.core.space_tree(space.id.clone()).unwrap();
    let node = tree.nodes.iter().find(|n| n.id == pinned[0]).unwrap();
    match &node.kind {
        NodeKindView::Tab { url, title, .. } => {
            assert_eq!(url, "https://a.test/next");
            assert_eq!(title, "Next");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn folders_move_rename_collapse_and_removal_closes_open_tabs() {
    let f = fixture();
    let space = first_space(&f.core);
    f.core.open_window("w1".into()).unwrap();
    let folder = f
        .core
        .create_folder(space.pinned_root.clone(), "Work".into(), 0)
        .unwrap();
    f.core
        .rename_node(folder.clone(), "Projects".into())
        .unwrap();
    f.core.set_collapsed(folder.clone(), true).unwrap();
    let live = f
        .core
        .open_url("w1".into(), space.id.clone(), "https://a.test/".into())
        .unwrap();
    f.core
        .pin_tab("w1".into(), live.clone(), folder.clone(), 0)
        .unwrap();
    let tree = f.core.space_tree(space.id.clone()).unwrap();
    assert!(tree.nodes.iter().any(|n| n.id == folder
        && n.kind
            == NodeKindView::Folder {
                title: "Projects".into(),
                collapsed: true
            }));

    f.core.remove_node(folder).unwrap();
    assert!(f.recorder.events().contains(&format!("close:{live}")));
    assert!(f
        .core
        .space_tree(space.id.clone())
        .unwrap()
        .nodes
        .is_empty());
}

#[test]
fn engine_opened_tabs_are_recorded_without_asking_the_bridge_to_open_them() {
    let f = fixture();
    let space = first_space(&f.core);
    f.core.open_window("w1".into()).unwrap();
    let opened = f
        .core
        .on_tab_opened("w1".into(), space.id.clone(), "https://popup.test/".into())
        .unwrap();
    let live = opened.live_tab.clone();
    assert_eq!(
        snapshot_ids(&f.core, &space.today_root, &space.id),
        vec![opened.node.clone()]
    );
    assert!(
        f.recorder.opened.lock().unwrap().is_empty(),
        "no on_open_tab for an engine-opened tab"
    );
    f.core
        .on_favicon(live.clone(), Some("https://popup.test/icon.png".into()))
        .unwrap();
    let node = snapshot_ids(&f.core, &space.today_root, &space.id).remove(0);
    let tree = f.core.space_tree(space.id.clone()).unwrap();
    match &tree.nodes.iter().find(|n| n.id == node).unwrap().kind {
        NodeKindView::Tab { icon, .. } => {
            assert_eq!(icon.as_deref(), Some("https://popup.test/icon.png"))
        }
        other => panic!("{other:?}"),
    }
    f.core.on_favicon(live, None).unwrap();
}

#[test]
fn a_tab_cannot_open_in_another_identity() {
    let f = fixture();
    let a = first_space(&f.core);
    let b_id = f
        .core
        .create_space("Work".into(), Icon::Symbol { name: "x".into() })
        .unwrap();
    f.core.open_window("w1".into()).unwrap();
    let live = f
        .core
        .open_url("w1".into(), a.id.clone(), "https://a.test/".into())
        .unwrap();
    f.core
        .pin_tab("w1".into(), live, a.pinned_root.clone(), 0)
        .unwrap();
    let node = snapshot_ids(&f.core, &a.pinned_root, &a.id).remove(0);
    let err = f.core.open_node("w1".into(), b_id, node).unwrap_err();
    assert!(matches!(err, CoreError::Invariant { .. }), "{err:?}");
}

#[test]
fn opening_an_open_node_selects_it_instead() {
    let f = fixture();
    let space = first_space(&f.core);
    f.core.open_window("w1".into()).unwrap();
    let live = f
        .core
        .open_url("w1".into(), space.id.clone(), "https://a.test/".into())
        .unwrap();
    let node = snapshot_ids(&f.core, &space.today_root, &space.id).remove(0);
    let again = f
        .core
        .open_node("w1".into(), space.id.clone(), node)
        .unwrap();
    assert_eq!(again, live);
    assert!(f.recorder.events().contains(&format!("select:{live}")));
}

#[test]
fn the_command_bar_finds_saved_tabs_and_offers_search() {
    let f = fixture();
    let space = first_space(&f.core);
    f.core.open_window("w1".into()).unwrap();
    let live = f
        .core
        .open_url("w1".into(), space.id.clone(), "https://mail.test/".into())
        .unwrap();
    f.core
        .on_navigation(
            live.clone(),
            "https://mail.test/".into(),
            "Mail".into(),
            Transition::Typed,
        )
        .unwrap();
    f.core
        .pin_tab("w1".into(), live, space.pinned_root.clone(), 0)
        .unwrap();
    let found = f
        .core
        .query_command_bar(space.id.clone(), "mail".into())
        .unwrap();
    assert_eq!(found[0].kind, SuggestionKind::Pinned);
    assert!(found[0].is_open);
    assert_eq!(found[1].kind, SuggestionKind::Search);
    assert!(found[1]
        .url
        .starts_with("https://www.google.com/search?q=mail"));
    let typed = f
        .core
        .query_command_bar(space.id.clone(), "example.com".into())
        .unwrap();
    assert_eq!(typed[0].kind, SuggestionKind::Url);
}

#[test]
fn switching_spaces_is_remembered() {
    let f = fixture();
    let b = f
        .core
        .create_space("Work".into(), Icon::Symbol { name: "x".into() })
        .unwrap();
    f.core.open_window("w1".into()).unwrap();
    f.core.switch_space("w1".into(), b.clone()).unwrap();
    assert!(f.recorder.events().contains(&format!("active:{b}")));
    let f = reopen(f);
    assert_eq!(f.core.last_active_space().unwrap(), Some(b));
}

#[test]
fn the_tab_in_front_is_remembered_while_it_exists() {
    let f = fixture();
    let space = first_space(&f.core);
    f.core.open_window("w1".into()).unwrap();
    assert_eq!(f.core.last_tab(space.id.clone()).unwrap(), None);
    f.core
        .open_url("w1".into(), space.id.clone(), "https://a.test/".into())
        .unwrap();
    let tree = f.core.space_tree(space.id.clone()).unwrap();
    let node = tree
        .nodes
        .iter()
        .find(|n| matches!(n.kind, NodeKindView::Tab { .. }))
        .unwrap()
        .id
        .clone();
    f.core.set_last_tab(space.id.clone(), node.clone()).unwrap();
    let f = reopen(f);
    assert_eq!(
        f.core.last_tab(space.id.clone()).unwrap(),
        Some(node.clone())
    );
    f.core.remove_node(node).unwrap();
    assert_eq!(f.core.last_tab(space.id).unwrap(), None);
}

#[test]
fn a_removed_folder_comes_back_with_its_rows_in_place() {
    let f = fixture();
    let space = first_space(&f.core);
    f.core.open_window("w1".into()).unwrap();
    let folder = f
        .core
        .create_folder(space.pinned_root.clone(), "Reading".into(), 0)
        .unwrap();
    let other = f
        .core
        .create_folder(space.pinned_root.clone(), "Other".into(), 1)
        .unwrap();
    let live = f
        .core
        .open_url("w1".into(), space.id.clone(), "https://a.test/".into())
        .unwrap();
    f.core
        .pin_tab("w1".into(), live, folder.clone(), 0)
        .unwrap();
    let before = f.core.space_tree(space.id.clone()).unwrap();

    f.core.remove_node(folder.clone()).unwrap();
    let removed = f.core.space_tree(space.id.clone()).unwrap();
    assert_eq!(removed.nodes.len(), before.nodes.len() - 2);

    assert_eq!(f.core.undo_remove().unwrap(), Some(folder.clone()));
    let after = f.core.space_tree(space.id.clone()).unwrap();
    let mut a = before.nodes.clone();
    let mut b = after.nodes.clone();
    a.sort_by(|x, y| x.id.cmp(&y.id));
    b.sort_by(|x, y| x.id.cmp(&y.id));
    assert_eq!(a, b, "the folder and its page are back");
    assert_eq!(before.children, after.children, "in the same places");
    assert!(after.nodes.iter().any(|n| n.id == other));

    let f = reopen(f);
    let reloaded = f.core.space_tree(space.id).unwrap();
    assert_eq!(reloaded.nodes.len(), before.nodes.len(), "and it was saved");
    assert_eq!(
        f.core.undo_remove().unwrap(),
        None,
        "nothing more to put back"
    );
}

#[test]
fn closing_stops_events_but_not_commands() {
    let f = fixture();
    let space = first_space(&f.core);
    f.core.open_window("w1".into()).unwrap();
    f.core
        .create_folder(space.pinned_root.clone(), "before".into(), 0)
        .unwrap();
    let seen = f.recorder.events().len();
    assert!(seen > 0);
    f.core.close();
    f.core
        .create_folder(space.pinned_root.clone(), "after".into(), 1)
        .unwrap();
    assert_eq!(f.recorder.events().len(), seen, "no events after close");
    assert_eq!(
        snapshot_ids(&f.core, &space.pinned_root, &space.id).len(),
        2,
        "commands still work"
    );
}

#[test]
fn unknown_ids_are_not_found_errors() {
    let f = fixture();
    assert!(matches!(
        f.core.space_tree("nope".into()),
        Err(CoreError::NotFound { .. })
    ));
    assert!(matches!(
        f.core.open_url(
            "nowindow".into(),
            first_space(&f.core).id,
            "https://a.test/".into()
        ),
        Err(CoreError::NotFound { .. })
    ));
}

#[test]
fn importing_arc_adds_spaces_and_persists() {
    let f = fixture();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../core-store/tests/fixtures/arc_sidebar_synthetic.json");
    let report = f
        .core
        .import_arc(path.to_string_lossy().into_owned())
        .unwrap();
    assert_eq!(report.spaces, 3);
    assert_eq!(
        f.core.list_spaces().unwrap().len(),
        4,
        "Personal plus the three imported"
    );
    assert!(f.recorder.events().contains(&"spaces:4".to_owned()));
    let f = reopen(f);
    assert_eq!(f.core.list_spaces().unwrap().len(), 4);
    let bad = f
        .core
        .import_arc("/nonexistent/StorableSidebar.json".into());
    assert!(matches!(bad, Err(CoreError::Import { .. })));
}

#[test]
fn history_is_per_identity_and_feeds_the_command_bar() {
    let f = fixture();
    let a = first_space(&f.core);
    let b_id = f
        .core
        .create_space(
            "B".into(),
            Icon::Symbol {
                name: "star".into(),
            },
        )
        .unwrap();
    let b = f
        .core
        .list_spaces()
        .unwrap()
        .into_iter()
        .find(|s| s.id == b_id)
        .unwrap();
    f.core.open_window("w1".into()).unwrap();
    let live = f
        .core
        .open_url("w1".into(), a.id.clone(), "https://bank.test/login".into())
        .unwrap();
    f.core
        .on_navigation(
            live.clone(),
            "https://bank.test/login".into(),
            "Bank login".into(),
            Transition::Typed,
        )
        .unwrap();
    f.core
        .on_navigation(
            live.clone(),
            "https://bank.test/login".into(),
            "Bank, sign in".into(),
            Transition::Other,
        )
        .unwrap();
    f.core.on_tab_closed(live).unwrap();
    assert_eq!(f.core.history_count(a.id.clone()).unwrap(), 1);
    assert_eq!(f.core.history_count(b.id.clone()).unwrap(), 0);

    let in_a = f
        .core
        .query_command_bar(a.id.clone(), "bank".into())
        .unwrap();
    let page = in_a
        .iter()
        .find(|s| s.kind == SuggestionKind::History)
        .expect("the closed Today tab is still in history");
    assert_eq!(page.url, "https://bank.test/login");
    assert_eq!(page.title, "Bank, sign in", "the title update was kept");
    assert_eq!(page.node, None);
    let in_b = f
        .core
        .query_command_bar(b.id.clone(), "bank".into())
        .unwrap();
    assert!(in_b.iter().all(|s| s.kind != SuggestionKind::History));

    assert_eq!(f.core.clear_history(b.id.clone()).unwrap(), 0);
    assert_eq!(f.core.history_count(a.id.clone()).unwrap(), 1);
    let f = reopen(f);
    assert_eq!(f.core.history_count(a.id.clone()).unwrap(), 1, "kept");
    assert_eq!(f.core.clear_history(a.id.clone()).unwrap(), 1);
    assert_eq!(f.core.history_count(a.id).unwrap(), 0);
}

fn record(guid: &str, origin: &str) -> LoginRecord {
    LoginRecord {
        guid: guid.into(),
        origin: origin.into(),
        form_action_origin: Some(origin.into()),
        http_realm: None,
        username_field: "user".into(),
        password_field: "pass".into(),
        encrypted_username: "enc-user".into(),
        encrypted_password: "enc-pass".into(),
        time_created: 1,
        time_last_used: 1,
        time_password_changed: 1,
        times_used: 1,
    }
}

#[test]
fn logins_belong_to_the_container_of_a_space() {
    let f = fixture();
    let a = first_space(&f.core);
    let b_id = f
        .core
        .create_space(
            "B".into(),
            Icon::Symbol {
                name: "star".into(),
            },
        )
        .unwrap();
    let b = f
        .core
        .list_spaces()
        .unwrap()
        .into_iter()
        .find(|s| s.id == b_id)
        .unwrap();
    f.core
        .login_add(a.user_context_id, record("g1", "https://bank.test"))
        .unwrap();
    assert_eq!(f.core.logins_count(a.user_context_id).unwrap(), 1);
    assert_eq!(f.core.logins_count(b.user_context_id).unwrap(), 0);
    assert!(f.core.logins_all(b.user_context_id).unwrap().is_empty());
    let found = f
        .core
        .logins_for_origins(a.user_context_id, vec!["https://bank.test".into()])
        .unwrap();
    assert_eq!(found[0].guid, "g1");
    assert!(f.core.login_remove(b.user_context_id, "g1".into()).is_err());

    let f = reopen(f);
    assert_eq!(f.core.logins_count(a.user_context_id).unwrap(), 1, "kept");
    assert_eq!(f.core.logins_clear(a.user_context_id).unwrap(), 1);
}

#[test]
fn a_container_no_space_owns_has_no_logins() {
    let f = fixture();
    for context in [0, 9999] {
        assert!(matches!(
            f.core.logins_all(context),
            Err(CoreError::NotFound { .. })
        ));
        assert!(f
            .core
            .login_add(context, record("g", "https://x.test"))
            .is_err());
    }
}

#[test]
fn spaces_are_edited_reordered_and_deleted_and_it_all_persists() {
    let f = fixture();
    let a = first_space(&f.core);
    let b = f
        .core
        .create_space("Work".into(), Icon::Emoji { glyph: "W".into() })
        .unwrap();
    f.core
        .update_space(
            b.clone(),
            "Office".into(),
            Icon::Emoji { glyph: "O".into() },
        )
        .unwrap();
    f.core.move_space(b.clone(), 0).unwrap();
    let f = reopen(f);
    let spaces = f.core.list_spaces().unwrap();
    assert_eq!(spaces[0].id, b);
    assert_eq!(spaces[0].title, "Office");
    assert_eq!(spaces[1].id, a.id);

    let doomed = spaces[0].clone();
    let deleted = f.core.delete_space(doomed.id.clone()).unwrap();
    assert!(deleted.identity_removed);
    assert_eq!(deleted.user_context_id, doomed.user_context_id);
    assert!(f.core.delete_space(a.id.clone()).is_err(), "the last stays");

    let f = reopen(f);
    assert_eq!(f.core.list_spaces().unwrap().len(), 1);
    let again = f
        .core
        .create_space("New".into(), Icon::Emoji { glyph: "N".into() })
        .unwrap();
    let again = f
        .core
        .list_spaces()
        .unwrap()
        .into_iter()
        .find(|space| space.id == again)
        .unwrap();
    assert!(
        again.user_context_id > doomed.user_context_id,
        "the container of a deleted space is not used again, even after a restart"
    );
}

#[test]
fn a_folded_pinned_list_persists() {
    let f = fixture();
    let a = first_space(&f.core);
    assert!(!a.pinned_collapsed);
    f.core.set_pinned_collapsed(a.id.clone(), true).unwrap();
    let f = reopen(f);
    assert!(first_space(&f.core).pinned_collapsed);
    f.core.set_pinned_collapsed(a.id, false).unwrap();
    let f = reopen(f);
    assert!(!first_space(&f.core).pinned_collapsed);
}

#[test]
fn a_space_tint_persists() {
    let f = fixture();
    let a = first_space(&f.core);
    assert_eq!(a.tint, None);
    f.core
        .set_space_tint(a.id.clone(), Some("#7c9cff".into()))
        .unwrap();
    assert!(f
        .core
        .set_space_tint(a.id.clone(), Some("blue".into()))
        .is_err());
    let f = reopen(f);
    assert_eq!(first_space(&f.core).tint.as_deref(), Some("#7c9cff"));
    f.core.set_space_tint(a.id, None).unwrap();
    let f = reopen(f);
    assert_eq!(first_space(&f.core).tint, None);
}
