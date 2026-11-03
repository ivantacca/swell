/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use core_model::*;

struct TestEnv {
    counter: u64,
}

impl Env for TestEnv {
    fn now_ms(&self) -> i64 {
        1_000 + self.counter as i64
    }

    fn new_id(&mut self) -> String {
        self.counter += 1;
        format!("id{}", self.counter)
    }
}

fn model() -> Model {
    Model::new(Box::new(TestEnv { counter: 0 }), "test-device")
}

fn space(m: &mut Model, title: &str) -> SpaceId {
    m.create_space(title, Icon::Symbol("star".into()), None)
        .unwrap()
}

fn pinned(m: &Model, s: &SpaceId) -> NodeId {
    m.space(s).unwrap().pinned_root.clone()
}

fn today(m: &Model, s: &SpaceId) -> NodeId {
    m.space(s).unwrap().today_root.clone()
}

#[test]
fn spaces_get_distinct_nonzero_containers() {
    let mut m = model();
    let a = space(&mut m, "A");
    let b = space(&mut m, "B");
    let ida = m.identity_of_space(&a).unwrap().gecko_user_context_id;
    let idb = m.identity_of_space(&b).unwrap().gecko_user_context_id;
    assert_ne!(ida, 0);
    assert_ne!(idb, 0);
    assert_ne!(ida, idb);
    m.validate().unwrap();
}

#[test]
fn spaces_can_share_an_identity() {
    let mut m = model();
    let a = space(&mut m, "A");
    let identity = m.space(&a).unwrap().identity_id.clone();
    let b = m
        .create_space("B", Icon::Emoji("x".into()), Some(identity.clone()))
        .unwrap();
    assert_eq!(m.space(&b).unwrap().identity_id, identity);
    assert_eq!(m.identities().len(), 1);
    assert!(m.favorites_root(&identity).is_some());
    m.validate().unwrap();
}

#[test]
fn insert_and_move_keep_parent_and_children_in_agreement() {
    let mut m = model();
    let s = space(&mut m, "A");
    let root = pinned(&m, &s);
    let (folder, _) = m.insert_folder(&root, 0, "Work").unwrap();
    let (t1, _) = m.insert_tab(&folder, 0, "https://a.test/", "a").unwrap();
    let (t2, _) = m.insert_tab(&root, 1, "https://b.test/", "b").unwrap();
    m.validate().unwrap();
    let ops = m.move_node(&t2, &folder, 0).unwrap();
    assert_eq!(
        ops,
        vec![TreeOp::Moved {
            id: t2.clone(),
            parent: folder.clone(),
            index: 0
        }]
    );
    assert_eq!(m.children(&folder).unwrap(), vec![t2.clone(), t1.clone()]);
    assert_eq!(m.node(&t2).unwrap().parent_id, Some(folder));
    m.validate().unwrap();
}

#[test]
fn move_within_same_parent_uses_post_removal_index() {
    let mut m = model();
    let s = space(&mut m, "A");
    let root = pinned(&m, &s);
    let (a, _) = m.insert_tab(&root, 0, "https://a.test/", "a").unwrap();
    let (b, _) = m.insert_tab(&root, 1, "https://b.test/", "b").unwrap();
    let (c, _) = m.insert_tab(&root, 2, "https://c.test/", "c").unwrap();
    m.move_node(&a, &root, 2).unwrap();
    assert_eq!(m.children(&root).unwrap(), vec![b, c, a]);
    m.validate().unwrap();
}

#[test]
fn cycles_are_rejected() {
    let mut m = model();
    let s = space(&mut m, "A");
    let root = pinned(&m, &s);
    let (outer, _) = m.insert_folder(&root, 0, "outer").unwrap();
    let (inner, _) = m.insert_folder(&outer, 0, "inner").unwrap();
    assert!(matches!(
        m.move_node(&outer, &inner, 0),
        Err(ModelError::Invariant(_))
    ));
    assert!(matches!(
        m.move_node(&outer, &outer, 0),
        Err(ModelError::Invariant(_))
    ));
    m.validate().unwrap();
}

#[test]
fn roots_cannot_move_or_be_removed_and_tabs_cannot_have_children() {
    let mut m = model();
    let s = space(&mut m, "A");
    let root = pinned(&m, &s);
    let tdy = today(&m, &s);
    let (tab, _) = m.insert_tab(&root, 0, "https://a.test/", "a").unwrap();
    assert!(m.move_node(&root, &tdy, 0).is_err());
    assert!(m.remove_node(&root).is_err());
    assert!(m.insert_tab(&tab, 0, "https://b.test/", "b").is_err());
    assert!(m.insert_folder(&tdy, 0, "no folders in Today").is_err());
    m.validate().unwrap();
}

#[test]
fn index_beyond_end_is_rejected() {
    let mut m = model();
    let s = space(&mut m, "A");
    let root = pinned(&m, &s);
    assert!(m.insert_tab(&root, 1, "https://a.test/", "a").is_err());
}

#[test]
fn removing_a_folder_removes_its_subtree_and_closes_live_tabs() {
    let mut m = model();
    let s = space(&mut m, "A");
    let w = WindowId::from("w1");
    m.open_window(w.clone());
    let root = pinned(&m, &s);
    let (folder, _) = m.insert_folder(&root, 0, "F").unwrap();
    let (tab, _) = m.insert_tab(&folder, 0, "https://a.test/", "a").unwrap();
    let live = m.open_node(&w, &s, &tab).unwrap();
    let (ops, closed) = m.remove_node(&folder).unwrap();
    assert_eq!(ops, vec![TreeOp::Removed { id: folder.clone() }]);
    assert_eq!(closed, vec![live]);
    assert!(m.node(&tab).is_none());
    m.validate().unwrap();
}

#[test]
fn open_url_creates_a_today_tab_in_the_space() {
    let mut m = model();
    let s = space(&mut m, "A");
    let w = WindowId::from("w1");
    m.open_window(w.clone());
    let (live, ops) = m.open_url(&w, &s, "https://a.test/").unwrap();
    let today_root = today(&m, &s);
    assert!(matches!(&ops[0], TreeOp::Inserted { parent, .. } if *parent == today_root));
    let node = m.live_tab(&live).unwrap().node.clone();
    assert_eq!(
        m.identity_of_node(&node).unwrap().id,
        m.space(&s).unwrap().identity_id
    );
}

#[test]
fn a_tab_opens_only_in_its_own_identity() {
    let mut m = model();
    let a = space(&mut m, "A");
    let b = space(&mut m, "B");
    let w = WindowId::from("w1");
    m.open_window(w.clone());
    let (node, _) = m
        .insert_tab(&pinned(&m, &a), 0, "https://a.test/", "a")
        .unwrap();
    assert!(matches!(
        m.open_node(&w, &b, &node),
        Err(ModelError::Invariant(_))
    ));
    assert!(m.open_node(&w, &a, &node).is_ok());
}

#[test]
fn a_node_with_a_live_tab_cannot_move_to_another_identity() {
    let mut m = model();
    let a = space(&mut m, "A");
    let b = space(&mut m, "B");
    let w = WindowId::from("w1");
    m.open_window(w.clone());
    let (node, _) = m
        .insert_tab(&pinned(&m, &a), 0, "https://a.test/", "a")
        .unwrap();
    m.open_node(&w, &a, &node).unwrap();
    assert!(matches!(
        m.move_node(&node, &pinned(&m, &b), 0),
        Err(ModelError::Invariant(_))
    ));
    let (idle, _) = m
        .insert_tab(&pinned(&m, &a), 0, "https://i.test/", "i")
        .unwrap();
    assert!(m.move_node(&idle, &pinned(&m, &b), 0).is_ok());
}

#[test]
fn closing_a_today_tab_deletes_its_node_but_a_pinned_tab_keeps_it() {
    let mut m = model();
    let s = space(&mut m, "A");
    let w = WindowId::from("w1");
    m.open_window(w.clone());
    let (live, _) = m.open_url(&w, &s, "https://a.test/").unwrap();
    let node = m.live_tab(&live).unwrap().node.clone();
    let ops = m.close_live_tab(&live).unwrap();
    assert_eq!(ops, vec![TreeOp::Removed { id: node.clone() }]);
    assert!(m.node(&node).is_none());

    let (live2, _) = m.open_url(&w, &s, "https://b.test/").unwrap();
    let node2 = m.live_tab(&live2).unwrap().node.clone();
    m.pin_live_tab(&live2, &pinned(&m, &s), 0).unwrap();
    let ops = m.close_live_tab(&live2).unwrap();
    assert!(ops.is_empty());
    assert!(m.node(&node2).is_some());
    assert!(m.live_tab(&live2).is_none());
    m.validate().unwrap();
}

#[test]
fn pin_and_unpin_move_between_today_and_pinned() {
    let mut m = model();
    let s = space(&mut m, "A");
    let w = WindowId::from("w1");
    m.open_window(w.clone());
    let (live, _) = m.open_url(&w, &s, "https://a.test/").unwrap();
    let node = m.live_tab(&live).unwrap().node.clone();
    m.pin_live_tab(&live, &pinned(&m, &s), 0).unwrap();
    assert_eq!(m.node(&node).unwrap().parent_id, Some(pinned(&m, &s)));
    m.unpin_node(&node, &s).unwrap();
    assert_eq!(m.node(&node).unwrap().parent_id, Some(today(&m, &s)));
    m.validate().unwrap();
}

#[test]
fn pinning_into_another_identity_is_rejected() {
    let mut m = model();
    let a = space(&mut m, "A");
    let b = space(&mut m, "B");
    let w = WindowId::from("w1");
    m.open_window(w.clone());
    let (live, _) = m.open_url(&w, &a, "https://a.test/").unwrap();
    assert!(matches!(
        m.pin_live_tab(&live, &pinned(&m, &b), 0),
        Err(ModelError::Invariant(_))
    ));
}

#[test]
fn navigation_updates_the_tab_node() {
    let mut m = model();
    let s = space(&mut m, "A");
    let w = WindowId::from("w1");
    m.open_window(w.clone());
    let (live, _) = m.open_url(&w, &s, "https://a.test/").unwrap();
    let ops = m.navigated(&live, "https://a.test/next", "Next").unwrap();
    let node = m.live_tab(&live).unwrap().node.clone();
    match &m.node(&node).unwrap().kind {
        NodeKind::Tab(t) => {
            assert_eq!(t.url, "https://a.test/next");
            assert_eq!(t.title, "Next");
        }
        _ => panic!("not a tab"),
    }
    assert!(matches!(ops.as_slice(), [TreeOp::Updated { .. }]));
}

#[test]
fn a_tabs_icon_can_be_set_and_cleared() {
    let mut m = model();
    let s = space(&mut m, "A");
    let w = WindowId::from("w1");
    m.open_window(w.clone());
    let (live, _) = m.open_url(&w, &s, "https://a.test/").unwrap();
    let node = m.live_tab(&live).unwrap().node.clone();
    let ops = m
        .set_tab_icon(&live, Some("https://a.test/icon.png"))
        .unwrap();
    assert!(matches!(ops.as_slice(), [TreeOp::Updated { .. }]));
    match &m.node(&node).unwrap().kind {
        NodeKind::Tab(t) => assert_eq!(t.icon.as_deref(), Some("https://a.test/icon.png")),
        _ => panic!("not a tab"),
    }
    m.set_tab_icon(&live, None).unwrap();
    match &m.node(&node).unwrap().kind {
        NodeKind::Tab(t) => assert_eq!(t.icon, None),
        _ => panic!("not a tab"),
    }
    assert!(m.set_tab_icon(&LiveTabId::from("nope"), None).is_err());
}

#[test]
fn switch_space_requires_an_existing_space_and_window() {
    let mut m = model();
    let s = space(&mut m, "A");
    let w = WindowId::from("w1");
    assert!(m.switch_space(&w, &s).is_err());
    m.open_window(w.clone());
    assert!(m.switch_space(&w, &SpaceId::from("nope")).is_err());
    m.switch_space(&w, &s).unwrap();
    assert_eq!(m.window(&w).unwrap().active_space, Some(s));
}

#[test]
fn validate_catches_a_corrupted_tree() {
    let mut m = model();
    let s = space(&mut m, "A");
    let root = pinned(&m, &s);
    let (tab, _) = m.insert_tab(&root, 0, "https://a.test/", "a").unwrap();
    let mut nodes = m.nodes();
    for n in nodes.iter_mut() {
        if n.id == tab {
            n.parent_id = Some(today(&m, &s));
        }
    }
    let broken = Model::from_parts(
        Box::new(TestEnv { counter: 100 }),
        "d",
        m.identities(),
        m.spaces(),
        nodes,
    );
    assert!(matches!(broken, Err(ModelError::Invariant(_))));
}

#[test]
fn from_parts_round_trips() {
    let mut m = model();
    let s = space(&mut m, "A");
    m.insert_tab(&pinned(&m, &s), 0, "https://a.test/", "a")
        .unwrap();
    let copy = Model::from_parts(
        Box::new(TestEnv { counter: 100 }),
        "d",
        m.identities(),
        m.spaces(),
        m.nodes(),
    )
    .unwrap();
    assert_eq!(copy.spaces(), m.spaces());
    assert_eq!(copy.nodes().len(), m.nodes().len());
}

#[test]
fn a_space_is_renamed_and_reordered() {
    let mut m = model();
    let a = space(&mut m, "A");
    let b = space(&mut m, "B");
    let c = space(&mut m, "C");
    m.update_space(&b, "  Work  ", Icon::Emoji("W".into()))
        .unwrap();
    assert_eq!(m.space(&b).unwrap().title, "Work");
    assert_eq!(m.space(&b).unwrap().icon, Icon::Emoji("W".into()));
    assert!(m
        .update_space(&b, "   ", Icon::Symbol("star".into()))
        .is_err());
    let order = |m: &Model| m.spaces().iter().map(|s| s.id.clone()).collect::<Vec<_>>();
    m.move_space(&c, 0).unwrap();
    assert_eq!(order(&m), vec![c.clone(), a.clone(), b.clone()]);
    m.move_space(&c, 2).unwrap();
    assert_eq!(order(&m), vec![a, b, c.clone()]);
    assert!(m.move_space(&c, 3).is_err());
    m.validate().unwrap();
}

#[test]
fn deleting_a_space_removes_its_trees_identity_and_tabs() {
    let mut m = model();
    let a = space(&mut m, "A");
    let b = space(&mut m, "B");
    let window = WindowId::from("w");
    m.open_window(window.clone());
    m.switch_space(&window, &b).unwrap();
    let (live, _) = m.open_url(&window, &b, "https://b.test/").unwrap();
    let b_identity = m.space(&b).unwrap().identity_id.clone();
    let b_context = m.identity(&b_identity).unwrap().gecko_user_context_id;
    let nodes_before = m.nodes().len();

    assert!(m.delete_space(&SpaceId::from("nope")).is_err());
    let removed = m.delete_space(&b).unwrap();
    assert_eq!(removed.space.id, b);
    assert_eq!(removed.identity.as_ref().unwrap().id, b_identity);
    assert_eq!(removed.closed, vec![live]);
    assert_eq!(removed.moved_windows, vec![(window.clone(), a.clone())]);
    assert_eq!(m.window(&window).unwrap().active_space, Some(a.clone()));
    assert!(m.space(&b).is_none());
    assert!(m.identity(&b_identity).is_none());
    assert!(m.favorites_root(&b_identity).is_none());
    assert_eq!(
        m.nodes().len(),
        nodes_before - 4,
        "two roots, a favorites root and a tab"
    );
    m.validate().unwrap();

    assert!(m.delete_space(&a).is_err(), "the last space stays");
    let again = space(&mut m, "C");
    let context = m.identity_of_space(&again).unwrap().gecko_user_context_id;
    assert!(
        context > b_context,
        "a deleted container id is not given again"
    );
}

#[test]
fn a_shared_identity_survives_the_deletion_of_one_of_its_spaces() {
    let mut m = model();
    let a = space(&mut m, "A");
    let identity = m.space(&a).unwrap().identity_id.clone();
    let b = m
        .create_space("B", Icon::Symbol("star".into()), Some(identity.clone()))
        .unwrap();
    let removed = m.delete_space(&b).unwrap();
    assert!(removed.identity.is_none());
    assert!(m.identity(&identity).is_some());
    m.validate().unwrap();
}

#[test]
fn a_space_has_an_optional_tint() {
    let mut m = model();
    let a = space(&mut m, "A");
    assert_eq!(m.space(&a).unwrap().tint, None);
    m.set_space_tint(&a, Some("#3B6CF4")).unwrap();
    assert_eq!(m.space(&a).unwrap().tint.as_deref(), Some("#3b6cf4"));
    for bad in ["red", "#12345", "#12345g", "3b6cf4", "#3b6cf4ff"] {
        assert!(m.set_space_tint(&a, Some(bad)).is_err(), "{bad}");
    }
    m.set_space_tint(&a, None).unwrap();
    assert_eq!(m.space(&a).unwrap().tint, None);
    assert!(m.set_space_tint(&SpaceId::from("nope"), None).is_err());
}

#[test]
fn a_space_can_fold_its_pinned_list_away() {
    let mut m = model();
    let a = space(&mut m, "A");
    let b = space(&mut m, "B");
    assert!(!m.space(&a).unwrap().pinned_collapsed);
    m.set_pinned_collapsed(&a, true).unwrap();
    assert!(m.space(&a).unwrap().pinned_collapsed);
    assert!(!m.space(&b).unwrap().pinned_collapsed, "per space");
    m.set_pinned_collapsed(&a, false).unwrap();
    assert!(!m.space(&a).unwrap().pinned_collapsed);
    assert!(m.set_pinned_collapsed(&SpaceId::from("nope"), true).is_err());
}

#[test]
fn a_pinned_tab_keeps_its_page_when_it_navigates_and_a_today_tab_does_not() {
    let mut m = model();
    let s = space(&mut m, "S");
    let window = WindowId::from("w");
    m.open_window(window.clone());
    let (live, _) = m.open_url(&window, &s, "https://a.test/").unwrap();
    m.navigated(&live, "https://a.test/", "A").unwrap();
    m.navigated(&live, "https://a.test/next", "Next").unwrap();
    let node = m.live_tab(&live).unwrap().node.clone();
    let url = |m: &Model| match &m.node(&node).unwrap().kind {
        NodeKind::Tab(tab) => (tab.url.clone(), tab.title.clone()),
        _ => unreachable!(),
    };
    assert_eq!(
        url(&m),
        ("https://a.test/next".into(), "Next".into()),
        "Today follows"
    );

    m.pin_live_tab(&live, &pinned(&m, &s), 0).unwrap();
    assert!(m
        .navigated(&live, "https://b.test/", "B")
        .unwrap()
        .is_empty());
    assert_eq!(
        url(&m),
        ("https://a.test/next".into(), "Next".into()),
        "a pinned tab stays where it was pinned"
    );
    m.set_tab_icon(&live, Some("data:image/png;base64,AAA"))
        .unwrap();
    m.set_tab_icon(&live, Some("data:image/png;base64,BBB"))
        .unwrap();
    match &m.node(&node).unwrap().kind {
        NodeKind::Tab(tab) => assert_eq!(tab.icon.as_deref(), Some("data:image/png;base64,AAA")),
        _ => unreachable!(),
    }
    m.validate().unwrap();
}

#[test]
fn a_pinned_tab_can_be_pinned_again_where_it_is() {
    let mut m = model();
    let s = space(&mut m, "S");
    let window = WindowId::from("w");
    m.open_window(window.clone());
    let (live, _) = m.open_url(&window, &s, "https://a.test/").unwrap();
    assert!(
        m.repin(&live, "https://b.test/", "B").is_err(),
        "not while in Today"
    );
    m.pin_live_tab(&live, &pinned(&m, &s), 0).unwrap();
    m.navigated(&live, "https://b.test/", "B").unwrap();
    m.repin(&live, "https://b.test/", "B").unwrap();
    let node = m.live_tab(&live).unwrap().node.clone();
    match &m.node(&node).unwrap().kind {
        NodeKind::Tab(tab) => {
            assert_eq!(
                (tab.url.as_str(), tab.title.as_str()),
                ("https://b.test/", "B")
            );
            assert_eq!(tab.icon, None, "the icon is set again by the new page");
        }
        _ => unreachable!(),
    }
    assert_eq!(
        m.node(&node).unwrap().parent_id,
        Some(pinned(&m, &s)),
        "in place"
    );
    m.validate().unwrap();
}

#[test]
fn a_pinned_tab_follows_the_title_of_its_own_page_only() {
    let mut m = model();
    let s = space(&mut m, "S");
    let window = WindowId::from("w");
    m.open_window(window.clone());
    let (live, _) = m.open_url(&window, &s, "https://a.test/page").unwrap();
    m.pin_live_tab(&live, &pinned(&m, &s), 0).unwrap();
    let node = m.live_tab(&live).unwrap().node.clone();
    let tab = |m: &Model| match &m.node(&node).unwrap().kind {
        NodeKind::Tab(tab) => (tab.url.clone(), tab.title.clone()),
        _ => unreachable!(),
    };
    m.navigated(&live, "https://www.a.test/page/#top", "(1) Page")
        .unwrap();
    assert_eq!(tab(&m), ("https://a.test/page".into(), "(1) Page".into()));
    m.navigated(&live, "https://a.test/other", "Other").unwrap();
    assert_eq!(tab(&m), ("https://a.test/page".into(), "(1) Page".into()));
    m.navigated(&live, "https://a.test/page", "").unwrap();
    assert_eq!(tab(&m).1, "(1) Page", "an empty title does not erase it");
}
