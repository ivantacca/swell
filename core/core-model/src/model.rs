/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::diff::TreeOp;
use crate::entities::*;
use crate::error::{invariant, ModelError, Result};
use crate::ids::*;
use std::collections::{BTreeMap, HashMap, HashSet};

pub struct Model {
    env: Box<dyn Env>,
    device: String,
    identities: BTreeMap<IdentityId, Identity>,
    spaces: BTreeMap<SpaceId, Space>,
    space_order: Vec<SpaceId>,
    favorites: BTreeMap<IdentityId, NodeId>,
    nodes: HashMap<NodeId, Node>,
    windows: HashMap<WindowId, Window>,
    live_tabs: HashMap<LiveTabId, LiveTab>,
    /// The lowest container id a new identity may get, so that the id of a
    /// deleted space is never given to another one.
    next_user_context_id: u32,
    /// What `remove_node` took away most recently, newest last, so that it can be put back.
    removals: Vec<Removal>,
}

/// A removed row and everything below it, with the place it was in.
struct Removal {
    parent: NodeId,
    index: usize,
    /// The row first, then its descendants, each after its parent.
    nodes: Vec<Node>,
}

const MAX_REMOVALS: usize = 50;

/// What deleting a space took away, for the caller to clean up after.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemovedSpace {
    pub space: Space,
    /// The identity went too, because no other space used it.
    pub identity: Option<Identity>,
    pub closed: Vec<LiveTabId>,
    /// Windows that showed the space and now show another one.
    pub moved_windows: Vec<(WindowId, SpaceId)>,
}

fn not_found<T>(what: &str, id: &str) -> Result<T> {
    Err(ModelError::NotFound(format!("{what} {id}")))
}

/// Whether a node of kind `child` may sit directly under a node of kind `parent`.
fn can_contain(parent: &NodeKind, child: &NodeKind) -> bool {
    match (parent, child) {
        (_, NodeKind::Root(_)) | (NodeKind::Tab(_), _) => false,
        (NodeKind::Root(RootKind::Pinned(_)), _) | (NodeKind::Folder { .. }, _) => true,
        (NodeKind::Root(_), NodeKind::Tab(_)) => true,
        (NodeKind::Root(_), NodeKind::Folder { .. }) => false,
    }
}

/// Whether two addresses are the same page for a pinned tab: they may differ in
/// the fragment, a closing slash, the scheme and a leading "www.", which are
/// what a redirect or the page itself change.
fn same_page(a: &str, b: &str) -> bool {
    fn key(url: &str) -> String {
        let url = url.split('#').next().unwrap_or(url);
        let url = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .unwrap_or(url);
        let url = url.strip_prefix("www.").unwrap_or(url);
        url.trim_end_matches('/').to_owned()
    }
    key(a) == key(b)
}

impl Model {
    pub fn new(env: Box<dyn Env>, device: impl Into<String>) -> Self {
        Self {
            env,
            device: device.into(),
            identities: BTreeMap::new(),
            spaces: BTreeMap::new(),
            space_order: Vec::new(),
            favorites: BTreeMap::new(),
            nodes: HashMap::new(),
            windows: HashMap::new(),
            live_tabs: HashMap::new(),
            removals: Vec::new(),
            next_user_context_id: 1,
        }
    }

    pub fn next_user_context_id(&self) -> u32 {
        self.next_user_context_id
    }

    /// Keeps container ids below `next` from being handed out again.
    pub fn reserve_user_context_ids(&mut self, next: u32) {
        self.next_user_context_id = self.next_user_context_id.max(next);
    }

    /// Rebuilds a model from persisted rows and checks every invariant.
    pub fn from_parts(
        env: Box<dyn Env>,
        device: impl Into<String>,
        identities: Vec<Identity>,
        spaces: Vec<Space>,
        nodes: Vec<Node>,
    ) -> Result<Self> {
        let mut model = Self::new(env, device);
        for identity in identities {
            model.identities.insert(identity.id.clone(), identity);
        }
        for space in spaces {
            model.space_order.push(space.id.clone());
            model.spaces.insert(space.id.clone(), space);
        }
        for node in nodes {
            if let NodeKind::Root(RootKind::Favorites(identity)) = &node.kind {
                model.favorites.insert(identity.clone(), node.id.clone());
            }
            model.nodes.insert(node.id.clone(), node);
        }
        model.validate()?;
        Ok(model)
    }

    pub fn identities(&self) -> Vec<Identity> {
        self.identities.values().cloned().collect()
    }

    pub fn spaces(&self) -> Vec<Space> {
        self.space_order
            .iter()
            .filter_map(|id| self.spaces.get(id).cloned())
            .collect()
    }

    pub fn nodes(&self) -> Vec<Node> {
        let mut nodes: Vec<Node> = self.nodes.values().cloned().collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        nodes
    }

    pub fn space(&self, id: &SpaceId) -> Option<&Space> {
        self.spaces.get(id)
    }

    pub fn identity(&self, id: &IdentityId) -> Option<&Identity> {
        self.identities.get(id)
    }

    pub fn identity_of_space(&self, id: &SpaceId) -> Option<&Identity> {
        self.spaces
            .get(id)
            .and_then(|space| self.identities.get(&space.identity_id))
    }

    pub fn favorites_root(&self, identity: &IdentityId) -> Option<&Node> {
        self.favorites
            .get(identity)
            .and_then(|id| self.nodes.get(id))
    }

    pub fn node(&self, id: &NodeId) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn children(&self, id: &NodeId) -> Option<Vec<NodeId>> {
        self.nodes.get(id).map(|node| node.children.clone())
    }

    pub fn window(&self, id: &WindowId) -> Option<&Window> {
        self.windows.get(id)
    }

    pub fn live_tabs(&self) -> Vec<LiveTab> {
        let mut tabs: Vec<LiveTab> = self.live_tabs.values().cloned().collect();
        tabs.sort_by(|a, b| a.id.cmp(&b.id));
        tabs
    }

    pub fn live_tab(&self, id: &LiveTabId) -> Option<&LiveTab> {
        self.live_tabs.get(id)
    }

    /// The root a node hangs under, found by walking up the parent chain.
    pub fn root_of(&self, id: &NodeId) -> Option<&Node> {
        let mut current = self.nodes.get(id)?;
        for _ in 0..=self.nodes.len() {
            match &current.parent_id {
                None => return Some(current),
                Some(parent) => current = self.nodes.get(parent)?,
            }
        }
        None
    }

    pub fn identity_of_node(&self, id: &NodeId) -> Option<&Identity> {
        match &self.root_of(id)?.kind {
            NodeKind::Root(RootKind::Pinned(space) | RootKind::Today(space)) => {
                self.identity_of_space(space)
            }
            NodeKind::Root(RootKind::Favorites(identity)) => self.identities.get(identity),
            _ => None,
        }
    }

    pub fn create_identity(&mut self, name: &str) -> Result<IdentityId> {
        let next = self
            .identities
            .values()
            .map(|identity| identity.gecko_user_context_id)
            .max()
            .map_or(1, |max| max.saturating_add(1))
            .max(self.next_user_context_id);
        if next > MAX_USER_CONTEXT_ID {
            return invariant("no user context ids left");
        }
        let id = IdentityId(self.env.new_id());
        let root = self.new_node(None, NodeKind::Root(RootKind::Favorites(id.clone())));
        self.favorites.insert(id.clone(), root.id.clone());
        self.nodes.insert(root.id.clone(), root);
        self.identities.insert(
            id.clone(),
            Identity {
                id: id.clone(),
                name: name.to_owned(),
                gecko_user_context_id: next,
                profile_dir_key: format!("identity-{}", id.0),
            },
        );
        Ok(id)
    }

    /// Creates a space, with a new identity of its own unless `identity` names
    /// an existing one to share.
    pub fn create_space(
        &mut self,
        title: &str,
        icon: Icon,
        identity: Option<IdentityId>,
    ) -> Result<SpaceId> {
        let identity_id = match identity {
            Some(id) if self.identities.contains_key(&id) => id,
            Some(id) => return not_found("identity", id.as_str()),
            None => self.create_identity(title)?,
        };
        let id = SpaceId(self.env.new_id());
        let pinned = self.new_node(None, NodeKind::Root(RootKind::Pinned(id.clone())));
        let today = self.new_node(None, NodeKind::Root(RootKind::Today(id.clone())));
        let space = Space {
            id: id.clone(),
            title: title.to_owned(),
            icon,
            tint: None,
            pinned_collapsed: false,
            identity_id,
            pinned_root: pinned.id.clone(),
            today_root: today.id.clone(),
        };
        self.nodes.insert(pinned.id.clone(), pinned);
        self.nodes.insert(today.id.clone(), today);
        self.spaces.insert(id.clone(), space);
        self.space_order.push(id.clone());
        Ok(id)
    }

    /// Changes the title and icon of a space.
    pub fn update_space(&mut self, id: &SpaceId, title: &str, icon: Icon) -> Result<()> {
        let title = title.trim();
        if title.is_empty() {
            return invariant("a space needs a name");
        }
        let Some(space) = self.spaces.get_mut(id) else {
            return not_found("space", id.as_str());
        };
        space.title = title.to_owned();
        space.icon = icon;
        Ok(())
    }

    /// Sets the colour that tints a space's sidebar (`#rrggbb`), or clears it.
    pub fn set_space_tint(&mut self, id: &SpaceId, tint: Option<&str>) -> Result<()> {
        if let Some(tint) = tint {
            let hex = tint.strip_prefix('#').unwrap_or_default();
            if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return invariant("a tint is #rrggbb");
            }
        }
        let Some(space) = self.spaces.get_mut(id) else {
            return not_found("space", id.as_str());
        };
        space.tint = tint.map(str::to_lowercase);
        Ok(())
    }

    /// Folds the pinned list of a space away, or unfolds it.
    pub fn set_pinned_collapsed(&mut self, id: &SpaceId, collapsed: bool) -> Result<()> {
        let Some(space) = self.spaces.get_mut(id) else {
            return not_found("space", id.as_str());
        };
        space.pinned_collapsed = collapsed;
        Ok(())
    }

    /// Moves a space to `index` in the order the sidebar lists them.
    pub fn move_space(&mut self, id: &SpaceId, index: usize) -> Result<()> {
        let Some(from) = self.space_order.iter().position(|s| s == id) else {
            return not_found("space", id.as_str());
        };
        if index >= self.space_order.len() {
            return invariant("index beyond the end of the spaces");
        }
        let space = self.space_order.remove(from);
        self.space_order.insert(index, space);
        Ok(())
    }

    /// Deletes a space with its trees. Its identity goes too, with the
    /// favorites, when no other space shares it. The last space stays.
    pub fn delete_space(&mut self, id: &SpaceId) -> Result<RemovedSpace> {
        let Some(position) = self.space_order.iter().position(|s| s == id) else {
            return not_found("space", id.as_str());
        };
        if self.space_order.len() == 1 {
            return invariant("the last space cannot be deleted");
        }
        let space = self.spaces[id].clone();
        let shared = self
            .spaces
            .values()
            .any(|other| other.id != space.id && other.identity_id == space.identity_id);
        let mut doomed: HashSet<NodeId> = self.subtree(&space.pinned_root).into_iter().collect();
        doomed.extend(self.subtree(&space.today_root));
        let identity = if shared {
            None
        } else {
            if let Some(favorites) = self.favorites.remove(&space.identity_id) {
                doomed.extend(self.subtree(&favorites));
            }
            self.identities.remove(&space.identity_id)
        };
        let mut closed: Vec<LiveTabId> = self
            .live_tabs
            .values()
            .filter(|live| live.space == space.id || doomed.contains(&live.node))
            .map(|live| live.id.clone())
            .collect();
        closed.sort();
        for live in &closed {
            self.live_tabs.remove(live);
        }
        for node in &doomed {
            self.nodes.remove(node);
        }
        self.spaces.remove(id);
        self.space_order.remove(position);
        let fallback =
            self.space_order[position.saturating_sub(1).min(self.space_order.len() - 1)].clone();
        let mut moved_windows = Vec::new();
        for window in self.windows.values_mut() {
            if window.active_space.as_ref() == Some(id) {
                window.active_space = Some(fallback.clone());
                moved_windows.push((window.id.clone(), fallback.clone()));
            }
        }
        moved_windows.sort();
        if let Some(identity) = &identity {
            self.next_user_context_id = self
                .next_user_context_id
                .max(identity.gecko_user_context_id.saturating_add(1));
        }
        Ok(RemovedSpace {
            space,
            identity,
            closed,
            moved_windows,
        })
    }

    pub fn insert_folder(
        &mut self,
        parent: &NodeId,
        index: usize,
        title: &str,
    ) -> Result<(NodeId, Vec<TreeOp>)> {
        let kind = NodeKind::Folder {
            title: title.to_owned(),
            collapsed: false,
        };
        self.insert(parent, index, kind)
    }

    pub fn insert_tab(
        &mut self,
        parent: &NodeId,
        index: usize,
        url: &str,
        title: &str,
    ) -> Result<(NodeId, Vec<TreeOp>)> {
        let kind = NodeKind::Tab(TabData {
            url: url.to_owned(),
            title: title.to_owned(),
            custom_title: None,
            icon: None,
            last_active_at: self.env.now_ms(),
            muted: false,
        });
        self.insert(parent, index, kind)
    }

    /// Appends a node with an explicit creation time; used by importers.
    pub fn append_imported(
        &mut self,
        parent: &NodeId,
        kind: NodeKind,
        created_at: i64,
    ) -> Result<NodeId> {
        let index = self.get(parent)?.children.len();
        let (id, _) = self.insert(parent, index, kind)?;
        let node = self.nodes.get_mut(&id).unwrap();
        node.created_at = created_at;
        node.updated_at = created_at;
        Ok(id)
    }

    pub fn move_node(
        &mut self,
        id: &NodeId,
        new_parent: &NodeId,
        index: usize,
    ) -> Result<Vec<TreeOp>> {
        let node = self.get(id)?;
        if matches!(node.kind, NodeKind::Root(_)) {
            return invariant("roots cannot move");
        }
        let kind = node.kind.clone();
        let old_parent = node.parent_id.clone().expect("non-root has a parent");
        let destination = self.get(new_parent)?;
        if !can_contain(&destination.kind, &kind) {
            return invariant("destination cannot hold this node");
        }
        let mut ancestor = Some(new_parent.clone());
        while let Some(current) = ancestor {
            if &current == id {
                return invariant("a node cannot move into itself");
            }
            ancestor = self.nodes.get(&current).and_then(|n| n.parent_id.clone());
        }
        let destination_identity = self
            .identity_of_node(new_parent)
            .map(|identity| identity.id.clone());
        let subtree: HashSet<NodeId> = self.subtree(id).into_iter().collect();
        for live in self
            .live_tabs
            .values()
            .filter(|live| subtree.contains(&live.node))
        {
            let live_identity = self.spaces.get(&live.space).map(|s| &s.identity_id);
            if live_identity != destination_identity.as_ref() {
                return invariant("a node with an open tab cannot move to another identity");
            }
        }
        let remaining = self.get(&old_parent)?.children.len() - 1;
        let limit = if &old_parent == new_parent {
            remaining
        } else {
            self.get(new_parent)?.children.len()
        };
        if index > limit {
            return invariant("index beyond the end of the parent");
        }
        let now = self.env.now_ms();
        self.nodes
            .get_mut(&old_parent)
            .unwrap()
            .children
            .retain(|child| child != id);
        self.nodes
            .get_mut(new_parent)
            .unwrap()
            .children
            .insert(index, id.clone());
        let node = self.nodes.get_mut(id).unwrap();
        node.parent_id = Some(new_parent.clone());
        node.updated_at = now;
        node.updated_by_device = self.device.clone();
        Ok(vec![TreeOp::Moved {
            id: id.clone(),
            parent: new_parent.clone(),
            index: index as u32,
        }])
    }

    /// Removes a node and everything below it. Returns the ops plus the live
    /// tabs that were open on removed nodes, which the caller must close.
    pub fn remove_node(&mut self, id: &NodeId) -> Result<(Vec<TreeOp>, Vec<LiveTabId>)> {
        let node = self.get(id)?;
        let Some(parent) = node.parent_id.clone() else {
            return invariant("roots cannot be removed");
        };
        let order = self.subtree(id);
        let removal = Removal {
            index: self
                .nodes
                .get(&parent)
                .and_then(|p| p.children.iter().position(|child| child == id))
                .unwrap_or(0),
            parent: parent.clone(),
            nodes: order
                .iter()
                .filter_map(|node_id| self.nodes.get(node_id).cloned())
                .collect(),
        };
        let doomed: HashSet<NodeId> = order.into_iter().collect();
        let mut closed: Vec<LiveTabId> = self
            .live_tabs
            .values()
            .filter(|live| doomed.contains(&live.node))
            .map(|live| live.id.clone())
            .collect();
        closed.sort();
        for live in &closed {
            self.live_tabs.remove(live);
        }
        for node_id in &doomed {
            self.nodes.remove(node_id);
        }
        self.nodes
            .get_mut(&parent)
            .unwrap()
            .children
            .retain(|child| child != id);
        self.removals.push(removal);
        if self.removals.len() > MAX_REMOVALS {
            self.removals.remove(0);
        }
        Ok((vec![TreeOp::Removed { id: id.clone() }], closed))
    }

    /// Puts back the row `remove_node` took away last, where it was (at the end of
    /// its parent if the parent has fewer rows now). Returns its id, or `None` when
    /// there is nothing to put back or its parent is gone.
    pub fn undo_remove(&mut self) -> Result<Option<(NodeId, Vec<TreeOp>)>> {
        while let Some(removal) = self.removals.pop() {
            let Some(parent) = self.nodes.get_mut(&removal.parent) else {
                continue;
            };
            let index = removal.index.min(parent.children.len());
            let Some(root) = removal.nodes.first().map(|node| node.id.clone()) else {
                continue;
            };
            parent.children.insert(index, root.clone());
            let mut ops = Vec::with_capacity(removal.nodes.len());
            for (position, node) in removal.nodes.iter().enumerate() {
                self.nodes.insert(node.id.clone(), node.clone());
                let (node_parent, node_index) = if position == 0 {
                    (removal.parent.clone(), index)
                } else {
                    let node_parent = node
                        .parent_id
                        .clone()
                        .unwrap_or_else(|| removal.parent.clone());
                    let node_index = self
                        .nodes
                        .get(&node_parent)
                        .and_then(|p| p.children.iter().position(|child| child == &node.id))
                        .unwrap_or(0);
                    (node_parent, node_index)
                };
                ops.push(TreeOp::Inserted {
                    node: node.clone(),
                    parent: node_parent,
                    index: node_index as u32,
                });
            }
            return Ok(Some((root, ops)));
        }
        Ok(None)
    }

    /// Renames a folder, or sets a tab's custom title (an empty title clears it).
    pub fn rename_node(&mut self, id: &NodeId, title: &str) -> Result<Vec<TreeOp>> {
        self.update(id, |kind| match kind {
            NodeKind::Folder { title: t, .. } => {
                *t = title.to_owned();
                Ok(())
            }
            NodeKind::Tab(tab) => {
                tab.custom_title = (!title.is_empty()).then(|| title.to_owned());
                Ok(())
            }
            NodeKind::Root(_) => invariant("roots cannot be renamed"),
        })
    }

    pub fn set_collapsed(&mut self, id: &NodeId, collapsed: bool) -> Result<Vec<TreeOp>> {
        self.update(id, |kind| match kind {
            NodeKind::Folder { collapsed: c, .. } => {
                *c = collapsed;
                Ok(())
            }
            _ => invariant("only folders collapse"),
        })
    }

    pub fn open_window(&mut self, id: WindowId) {
        self.windows.entry(id.clone()).or_insert(Window {
            id,
            active_space: None,
        });
    }

    pub fn close_window(&mut self, id: &WindowId) {
        self.windows.remove(id);
        self.live_tabs.retain(|_, live| &live.window != id);
    }

    pub fn switch_space(&mut self, window: &WindowId, space: &SpaceId) -> Result<()> {
        if !self.spaces.contains_key(space) {
            return not_found("space", space.as_str());
        }
        match self.windows.get_mut(window) {
            Some(window) => {
                window.active_space = Some(space.clone());
                Ok(())
            }
            None => not_found("window", window.as_str()),
        }
    }

    /// Opens a new tab at `url` in the space's Today list.
    pub fn open_url(
        &mut self,
        window: &WindowId,
        space: &SpaceId,
        url: &str,
    ) -> Result<(LiveTabId, Vec<TreeOp>)> {
        self.check_window_and_space(window, space)?;
        let today = self.spaces[space].today_root.clone();
        let index = self.nodes[&today].children.len();
        let (node, ops) = self.insert_tab(&today, index, url, url)?;
        let live = self.attach(window, space, &node);
        Ok((live, ops))
    }

    /// Opens a saved node in `space`; the node must belong to the space's identity.
    pub fn open_node(
        &mut self,
        window: &WindowId,
        space: &SpaceId,
        node: &NodeId,
    ) -> Result<LiveTabId> {
        self.check_window_and_space(window, space)?;
        if !matches!(self.get(node)?.kind, NodeKind::Tab(_)) {
            return invariant("only tabs can be opened");
        }
        let space_identity = &self.spaces[space].identity_id;
        if self.identity_of_node(node).map(|i| &i.id) != Some(space_identity) {
            return invariant("a tab can only be opened in its own identity");
        }
        if let Some(existing) = self
            .live_tabs
            .values()
            .find(|live| &live.node == node && &live.window == window)
        {
            return Ok(existing.id.clone());
        }
        Ok(self.attach(window, space, node))
    }

    /// Closes a live tab. A Today node goes with it; a pinned one stays.
    pub fn close_live_tab(&mut self, live: &LiveTabId) -> Result<Vec<TreeOp>> {
        let Some(tab) = self.live_tabs.remove(live) else {
            return not_found("live tab", live.as_str());
        };
        let in_today = matches!(
            self.root_of(&tab.node).map(|root| &root.kind),
            Some(NodeKind::Root(RootKind::Today(_)))
        );
        if in_today {
            Ok(self.remove_node(&tab.node)?.0)
        } else {
            Ok(Vec::new())
        }
    }

    pub fn pin_live_tab(
        &mut self,
        live: &LiveTabId,
        into: &NodeId,
        index: usize,
    ) -> Result<Vec<TreeOp>> {
        let Some(tab) = self.live_tabs.get(live).cloned() else {
            return not_found("live tab", live.as_str());
        };
        let pinned_target = matches!(
            self.root_of(into).map(|root| &root.kind),
            Some(NodeKind::Root(RootKind::Pinned(_) | RootKind::Favorites(_)))
        );
        if !pinned_target {
            return invariant("tabs are pinned under Pinned or Favorites");
        }
        self.move_node(&tab.node, into, index)
    }

    /// Moves a pinned or favorite tab to the end of `space`'s Today list.
    pub fn unpin_node(&mut self, node: &NodeId, space: &SpaceId) -> Result<Vec<TreeOp>> {
        let Some(target) = self.spaces.get(space) else {
            return not_found("space", space.as_str());
        };
        let today = target.today_root.clone();
        let index = self.nodes[&today].children.len();
        self.move_node(node, &today, index)
    }

    /// Records a top-level navigation of a live tab.
    /// Records where a live tab went. A tab that is pinned or a favorite keeps
    /// the page it was pinned at: it shows where it is while it is open, and
    /// closing it and opening it again starts from the pinned page.
    pub fn navigated(&mut self, live: &LiveTabId, url: &str, title: &str) -> Result<Vec<TreeOp>> {
        let Some(node) = self.live_tabs.get(live).map(|tab| tab.node.clone()) else {
            return not_found("live tab", live.as_str());
        };
        if self.is_saved(&node) {
            // On its own page a pinned tab follows the title of the page, and
            // that is all it follows.
            let same = matches!(
                self.node(&node).map(|n| &n.kind),
                Some(NodeKind::Tab(tab)) if same_page(&tab.url, url)
            );
            if !same || title.is_empty() {
                return Ok(Vec::new());
            }
            return self.update(&node, |kind| match kind {
                NodeKind::Tab(tab) => {
                    tab.title = title.to_owned();
                    Ok(())
                }
                _ => invariant("only tabs navigate"),
            });
        }
        let now = self.env.now_ms();
        self.update(&node, |kind| match kind {
            NodeKind::Tab(tab) => {
                tab.url = url.to_owned();
                tab.title = title.to_owned();
                tab.last_active_at = now;
                Ok(())
            }
            _ => invariant("only tabs navigate"),
        })
    }

    /// Makes the page a live tab is on the page its pinned node starts from, in
    /// place, so that closing it and opening it again starts there.
    pub fn repin(&mut self, live: &LiveTabId, url: &str, title: &str) -> Result<Vec<TreeOp>> {
        let Some(node) = self.live_tabs.get(live).map(|tab| tab.node.clone()) else {
            return not_found("live tab", live.as_str());
        };
        if !self.is_saved(&node) {
            return invariant("only a pinned tab or a favorite has a page to start from");
        }
        let now = self.env.now_ms();
        self.update(&node, |kind| match kind {
            NodeKind::Tab(tab) => {
                tab.url = url.to_owned();
                tab.title = title.to_owned();
                tab.icon = None;
                tab.last_active_at = now;
                Ok(())
            }
            _ => invariant("only tabs navigate"),
        })
    }

    /// Sets or clears the favicon of a live tab's node.
    pub fn set_tab_icon(&mut self, live: &LiveTabId, icon: Option<&str>) -> Result<Vec<TreeOp>> {
        let Some(node) = self.live_tabs.get(live).map(|tab| tab.node.clone()) else {
            return not_found("live tab", live.as_str());
        };
        let saved = self.is_saved(&node);
        self.update(&node, |kind| match kind {
            // A saved tab keeps its icon once it has one, as it keeps its page.
            NodeKind::Tab(tab) if saved && tab.icon.is_some() => Ok(()),
            NodeKind::Tab(tab) => {
                tab.icon = icon.map(str::to_owned);
                Ok(())
            }
            _ => invariant("only tabs have icons"),
        })
    }

    /// Whether a node is pinned or a favorite, as opposed to being in Today.
    fn is_saved(&self, node: &NodeId) -> bool {
        matches!(
            self.root_of(node).map(|root| &root.kind),
            Some(NodeKind::Root(RootKind::Pinned(_) | RootKind::Favorites(_)))
        )
    }

    /// Checks every invariant of the model.
    pub fn validate(&self) -> Result<()> {
        let mut contexts = HashSet::new();
        for identity in self.identities.values() {
            let id = identity.gecko_user_context_id;
            if id == 0 || id > MAX_USER_CONTEXT_ID || !contexts.insert(id) {
                return invariant(format!("bad user context id {id}"));
            }
            match self.favorites_root(&identity.id).map(|n| &n.kind) {
                Some(NodeKind::Root(RootKind::Favorites(owner))) if owner == &identity.id => {}
                _ => return invariant(format!("identity {} lacks a favorites root", identity.id)),
            }
        }
        for space in self.spaces.values() {
            if !self.identities.contains_key(&space.identity_id) {
                return invariant(format!("space {} has no identity", space.id));
            }
            let pinned = self.nodes.get(&space.pinned_root).map(|n| &n.kind);
            let today = self.nodes.get(&space.today_root).map(|n| &n.kind);
            if !matches!(pinned, Some(NodeKind::Root(RootKind::Pinned(s))) if s == &space.id)
                || !matches!(today, Some(NodeKind::Root(RootKind::Today(s))) if s == &space.id)
            {
                return invariant(format!("space {} has bad roots", space.id));
            }
        }
        if self.space_order.len() != self.spaces.len() {
            return invariant("space order disagrees with spaces");
        }
        let root_count = self
            .nodes
            .values()
            .filter(|n| matches!(n.kind, NodeKind::Root(_)))
            .count();
        if root_count != self.spaces.len() * 2 + self.identities.len() {
            return invariant("unexpected number of roots");
        }
        for node in self.nodes.values() {
            match (&node.kind, &node.parent_id) {
                (NodeKind::Root(_), None) => {}
                (NodeKind::Root(_), Some(_)) => return invariant("a root has a parent"),
                (_, None) => return invariant(format!("node {} has no parent", node.id)),
                (kind, Some(parent_id)) => {
                    let Some(parent) = self.nodes.get(parent_id) else {
                        return invariant(format!("node {} has a missing parent", node.id));
                    };
                    if parent.children.iter().filter(|c| **c == node.id).count() != 1 {
                        return invariant(format!("parent of {} disagrees", node.id));
                    }
                    if !can_contain(&parent.kind, kind) {
                        return invariant(format!("node {} is in the wrong place", node.id));
                    }
                    if !matches!(
                        self.root_of(&node.id).map(|r| &r.kind),
                        Some(NodeKind::Root(_))
                    ) {
                        return invariant(format!("node {} does not reach a root", node.id));
                    }
                }
            }
            let mut seen = HashSet::new();
            for child in &node.children {
                let Some(child_node) = self.nodes.get(child) else {
                    return invariant(format!("node {} lists a missing child", node.id));
                };
                if child_node.parent_id.as_ref() != Some(&node.id) || !seen.insert(child) {
                    return invariant(format!("child {child} of {} disagrees", node.id));
                }
            }
        }
        for live in self.live_tabs.values() {
            let space = self.spaces.get(&live.space);
            let identity = self.identity_of_node(&live.node).map(|i| &i.id);
            if space.map(|s| &s.identity_id) != identity || identity.is_none() {
                return invariant(format!("live tab {} is in the wrong identity", live.id));
            }
        }
        Ok(())
    }

    fn get(&self, id: &NodeId) -> Result<&Node> {
        match self.nodes.get(id) {
            Some(node) => Ok(node),
            None => not_found("node", id.as_str()),
        }
    }

    fn new_node(&mut self, parent: Option<NodeId>, kind: NodeKind) -> Node {
        let now = self.env.now_ms();
        Node {
            id: NodeId(self.env.new_id()),
            parent_id: parent,
            children: Vec::new(),
            created_at: now,
            updated_at: now,
            updated_by_device: self.device.clone(),
            kind,
        }
    }

    fn insert(
        &mut self,
        parent: &NodeId,
        index: usize,
        kind: NodeKind,
    ) -> Result<(NodeId, Vec<TreeOp>)> {
        let container = self.get(parent)?;
        if !can_contain(&container.kind, &kind) {
            return invariant("parent cannot hold this node");
        }
        if index > container.children.len() {
            return invariant("index beyond the end of the parent");
        }
        let node = self.new_node(Some(parent.clone()), kind);
        let id = node.id.clone();
        self.nodes
            .get_mut(parent)
            .unwrap()
            .children
            .insert(index, id.clone());
        self.nodes.insert(id.clone(), node.clone());
        let op = TreeOp::Inserted {
            node,
            parent: parent.clone(),
            index: index as u32,
        };
        Ok((id, vec![op]))
    }

    fn update(
        &mut self,
        id: &NodeId,
        change: impl FnOnce(&mut NodeKind) -> Result<()>,
    ) -> Result<Vec<TreeOp>> {
        self.get(id)?;
        let now = self.env.now_ms();
        let device = self.device.clone();
        let node = self.nodes.get_mut(id).unwrap();
        let mut kind = node.kind.clone();
        change(&mut kind)?;
        node.kind = kind;
        node.updated_at = now;
        node.updated_by_device = device;
        Ok(vec![TreeOp::Updated { node: node.clone() }])
    }

    fn subtree(&self, id: &NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack = vec![id.clone()];
        while let Some(current) = stack.pop() {
            if let Some(node) = self.nodes.get(&current) {
                stack.extend(node.children.iter().cloned());
            }
            out.push(current);
        }
        out
    }

    fn check_window_and_space(&self, window: &WindowId, space: &SpaceId) -> Result<()> {
        if !self.windows.contains_key(window) {
            return not_found("window", window.as_str());
        }
        if !self.spaces.contains_key(space) {
            return not_found("space", space.as_str());
        }
        Ok(())
    }

    fn attach(&mut self, window: &WindowId, space: &SpaceId, node: &NodeId) -> LiveTabId {
        let id = LiveTabId(self.env.new_id());
        self.live_tabs.insert(
            id.clone(),
            LiveTab {
                id: id.clone(),
                window: window.clone(),
                space: space.clone(),
                node: node.clone(),
            },
        );
        id
    }
}
