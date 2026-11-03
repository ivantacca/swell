/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::types::*;
use core_history::History;
use core_logins::Logins;
use core_model::{Env, LiveTabId, Model, NodeId, NodeKind, SpaceId, SystemEnv, WindowId};
use core_search::{default_engines, Candidate, CandidateKind};
use core_store::Store;
use std::path::Path;
use std::sync::{Arc, Mutex};

const SUGGESTION_LIMIT: usize = 8;
/// History pages looked up for one command-bar query, before ranking.
const HISTORY_CANDIDATES: usize = 30;
const META_DEVICE: &str = "device_id";
const META_LAST_SPACE: &str = "last_space";
const META_NEXT_CONTEXT: &str = "next_user_context_id";
const META_LAST_TAB: &str = "last_tab:";

enum Event {
    Tree(TreeDiff),
    Spaces(Vec<SpaceView>),
    ActiveSpace {
        window: String,
        space: String,
    },
    OpenTab {
        window: String,
        space: String,
        user_context_id: u32,
        url: String,
        live_tab: String,
        node: String,
    },
    SelectTab {
        window: String,
        live_tab: String,
    },
    CloseTab {
        window: String,
        live_tab: String,
    },
}

struct Inner {
    model: Model,
    store: Store,
    history: History,
    logins: Logins,
    listeners: Vec<Arc<dyn CoreListener>>,
    /// Set when a write failed; the next write saves everything instead.
    dirty: bool,
}

impl Inner {
    fn persist_ops(&mut self, ops: &[core_model::TreeOp]) -> Result<(), CoreError> {
        let saved = if self.dirty {
            self.store.save_all(&self.model)
        } else {
            self.store.apply(&self.model, ops)
        };
        self.dirty = saved.is_err();
        Ok(saved?)
    }

    fn persist_structure(&mut self) -> Result<(), CoreError> {
        let saved = if self.dirty {
            self.store.save_all(&self.model)
        } else {
            self.store.sync_structure(&self.model)
        };
        self.dirty = saved.is_err();
        Ok(saved?)
    }

    fn persist_removals(&mut self) -> Result<(), CoreError> {
        let saved = if self.dirty {
            self.store.save_all(&self.model)
        } else {
            self.store.sync_removals(&self.model)
        };
        self.dirty = saved.is_err();
        Ok(saved?)
    }

    fn space_views(&self) -> Vec<SpaceView> {
        self.model
            .spaces()
            .iter()
            .filter_map(|space| {
                let identity = self.model.identity(&space.identity_id)?;
                let favorites = self.model.favorites_root(&space.identity_id)?;
                Some(SpaceView {
                    id: space.id.0.clone(),
                    title: space.title.clone(),
                    icon: (&space.icon).into(),
                    tint: space.tint.clone(),
                    pinned_collapsed: space.pinned_collapsed,
                    identity_id: identity.id.0.clone(),
                    user_context_id: identity.gecko_user_context_id,
                    pinned_root: space.pinned_root.0.clone(),
                    today_root: space.today_root.0.clone(),
                    favorites_root: favorites.id.0.clone(),
                })
            })
            .collect()
    }

    /// The identity that owns a container; a container no identity owns (the
    /// default one, or one that was never made) has no logins to read or write.
    fn identity_for_context(&self, user_context_id: u32) -> Result<String, CoreError> {
        self.model
            .identities()
            .into_iter()
            .find(|identity| identity.gecko_user_context_id == user_context_id)
            .map(|identity| identity.id.0)
            .ok_or_else(|| CoreError::NotFound {
                what: format!("container {user_context_id}"),
            })
    }

    /// The identity of the space a live tab belongs to.
    fn identity_of_live_tab(&self, live: &LiveTabId) -> Option<String> {
        let tab = self.model.live_tab(live)?;
        Some(self.model.identity_of_space(&tab.space)?.id.0.clone())
    }

    fn space(&self, id: &str) -> Result<core_model::Space, CoreError> {
        self.model
            .space(&SpaceId::from(id))
            .cloned()
            .ok_or_else(|| CoreError::NotFound {
                what: format!("space {id}"),
            })
    }

    fn user_context_id(&self, space: &core_model::Space) -> u32 {
        self.model
            .identity(&space.identity_id)
            .map_or(0, |identity| identity.gecko_user_context_id)
    }

    fn tree_event(ops: &[core_model::TreeOp], events: &mut Vec<Event>) {
        let ops: Vec<TreeOp> = ops.iter().filter_map(TreeOp::of).collect();
        if !ops.is_empty() {
            events.push(Event::Tree(TreeDiff { ops }));
        }
    }

    /// Roots shown for a space: Pinned, Today and the identity's Favorites.
    fn roots(&self, space: &core_model::Space) -> Vec<(NodeId, CandidateKind)> {
        let mut roots = vec![
            (space.pinned_root.clone(), CandidateKind::Pinned),
            (space.today_root.clone(), CandidateKind::Today),
        ];
        if let Some(favorites) = self.model.favorites_root(&space.identity_id) {
            roots.push((favorites.id.clone(), CandidateKind::Pinned));
        }
        roots
    }

    fn collect(&self, root: &NodeId, snapshot: &mut TreeSnapshot) {
        let ids = self.model.children(root).unwrap_or_default();
        snapshot.children.push(ChildList {
            parent: root.0.clone(),
            ids: ids.iter().map(|id| id.0.clone()).collect(),
        });
        for id in ids {
            let Some(node) = self.model.node(&id) else {
                continue;
            };
            snapshot.nodes.extend(NodeView::of(node));
            if matches!(node.kind, NodeKind::Folder { .. }) {
                self.collect(&id, snapshot);
            }
        }
    }

    fn candidates(&self, root: &NodeId, kind: CandidateKind, out: &mut Vec<Candidate>) {
        let open: Vec<NodeId> = self.model.live_tabs().into_iter().map(|t| t.node).collect();
        let mut stack = vec![root.clone()];
        while let Some(id) = stack.pop() {
            let Some(node) = self.model.node(&id) else {
                continue;
            };
            stack.extend(node.children.iter().cloned());
            if let NodeKind::Tab(tab) = &node.kind {
                out.push(Candidate {
                    id: id.0.clone(),
                    kind,
                    title: tab
                        .custom_title
                        .clone()
                        .unwrap_or_else(|| tab.title.clone()),
                    url: tab.url.clone(),
                    is_open: open.contains(&id),
                    last_active_at: tab.last_active_at,
                    weight: 0,
                });
            }
        }
    }
}

#[derive(uniffi::Object)]
pub struct SwellCore {
    inner: Mutex<Inner>,
}

impl SwellCore {
    /// Runs a command under the lock, then delivers its events with the lock
    /// released so a listener can call back into the core.
    fn run<T>(
        &self,
        command: impl FnOnce(&mut Inner, &mut Vec<Event>) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let mut events = Vec::new();
        let (result, listeners) = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let result = command(&mut inner, &mut events);
            (result, inner.listeners.clone())
        };
        for event in &events {
            for listener in &listeners {
                match event {
                    Event::Tree(diff) => listener.on_tree_changed(diff.clone()),
                    Event::Spaces(spaces) => listener.on_spaces_changed(spaces.clone()),
                    Event::ActiveSpace { window, space } => {
                        listener.on_active_space_changed(window.clone(), space.clone())
                    }
                    Event::OpenTab {
                        window,
                        space,
                        user_context_id,
                        url,
                        live_tab,
                        node,
                    } => listener.on_open_tab(
                        window.clone(),
                        space.clone(),
                        *user_context_id,
                        url.clone(),
                        live_tab.clone(),
                        node.clone(),
                    ),
                    Event::SelectTab { window, live_tab } => {
                        listener.on_select_tab(window.clone(), live_tab.clone())
                    }
                    Event::CloseTab { window, live_tab } => {
                        listener.on_close_tab(window.clone(), live_tab.clone())
                    }
                }
            }
        }
        result
    }
}

#[uniffi::export]
impl SwellCore {
    /// Opens (creating on first run) the sidebar database in `dir`. A first
    /// run starts with one space, "Personal".
    #[uniffi::constructor]
    pub fn open(dir: String) -> Result<Arc<Self>, CoreError> {
        let mut store = Store::open(Path::new(&dir))?;
        let history = History::open(Path::new(&dir))?;
        let logins = Logins::open(Path::new(&dir))?;
        let device = match store.get_meta(META_DEVICE)? {
            Some(device) => device,
            None => {
                let device = SystemEnv.new_id();
                store.set_meta(META_DEVICE, &device)?;
                device
            }
        };
        let mut model = store.load(Box::new(SystemEnv), &device)?;
        if let Some(next) = store
            .get_meta(META_NEXT_CONTEXT)?
            .and_then(|next| next.parse().ok())
        {
            model.reserve_user_context_ids(next);
        }
        if model.spaces().is_empty() {
            let id =
                model.create_space("Personal", core_model::Icon::Symbol("person".into()), None)?;
            store.sync_structure(&model)?;
            store.set_meta(META_LAST_SPACE, id.as_str())?;
        }
        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                model,
                store,
                history,
                logins,
                listeners: Vec::new(),
                dirty: false,
            }),
        }))
    }

    pub fn add_listener(&self, listener: Box<dyn CoreListener>) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.listeners.push(Arc::from(listener));
    }

    /// Drops every listener. The window calls this as the application quits:
    /// UniFFI aborts at shutdown if a callback interface is still registered.
    pub fn close(&self) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.listeners.clear();
    }

    pub fn list_spaces(&self) -> Result<Vec<SpaceView>, CoreError> {
        self.run(|inner, _| Ok(inner.space_views()))
    }

    /// The space the user last switched to, if it still exists.
    pub fn last_active_space(&self) -> Result<Option<String>, CoreError> {
        self.run(|inner, _| {
            let last = inner.store.get_meta(META_LAST_SPACE)?;
            Ok(last.filter(|id| inner.model.space(&SpaceId::from(id.as_str())).is_some()))
        })
    }

    /// The saved tab the user last had in front in `space`, if it still exists.
    pub fn last_tab(&self, space: String) -> Result<Option<String>, CoreError> {
        self.run(|inner, _| {
            let last = inner.store.get_meta(&format!("{META_LAST_TAB}{space}"))?;
            Ok(last.filter(|id| inner.model.node(&NodeId::from(id.as_str())).is_some()))
        })
    }

    /// Remembers the saved tab in front in `space`, to open it again at the next start.
    pub fn set_last_tab(&self, space: String, node: String) -> Result<(), CoreError> {
        self.run(|inner, _| {
            inner.space(&space)?;
            Ok(inner
                .store
                .set_meta(&format!("{META_LAST_TAB}{space}"), &node)?)
        })
    }

    /// The saved page zoom of `host` in the space's identity; 1.0 when none.
    pub fn site_zoom(&self, space: String, host: String) -> Result<f64, CoreError> {
        self.run(|inner, _| {
            let space = inner.space(&space)?;
            Ok(inner
                .store
                .site_zoom(&space.identity_id.0, &host)?
                .unwrap_or(1.0))
        })
    }

    /// Saves the page zoom of `host` for the space's identity. 1.0 forgets it;
    /// other values are limited to what the engine accepts (0.3 to 5).
    pub fn set_site_zoom(&self, space: String, host: String, factor: f64) -> Result<(), CoreError> {
        self.run(|inner, _| {
            let space = inner.space(&space)?;
            if !factor.is_finite() {
                return Err(CoreError::Invariant {
                    reason: format!("zoom {factor} is not a number"),
                });
            }
            let factor = factor.clamp(0.3, 5.0);
            let saved = if (factor - 1.0).abs() < 1e-9 {
                None
            } else {
                Some(factor)
            };
            Ok(inner
                .store
                .set_site_zoom(&space.identity_id.0, &host, saved)?)
        })
    }

    pub fn space_tree(&self, space: String) -> Result<TreeSnapshot, CoreError> {
        self.run(|inner, _| {
            let space = inner.space(&space)?;
            let mut snapshot = TreeSnapshot {
                nodes: Vec::new(),
                children: Vec::new(),
            };
            for (root, _) in inner.roots(&space) {
                inner.collect(&root, &mut snapshot);
            }
            Ok(snapshot)
        })
    }

    pub fn create_space(&self, title: String, icon: Icon) -> Result<String, CoreError> {
        self.run(|inner, events| {
            let id = inner.model.create_space(&title, icon.into(), None)?;
            events.push(Event::Spaces(inner.space_views()));
            inner.persist_structure()?;
            Ok(id.0)
        })
    }

    /// Renames a space and changes its icon.
    pub fn update_space(&self, space: String, title: String, icon: Icon) -> Result<(), CoreError> {
        self.run(|inner, events| {
            inner
                .model
                .update_space(&SpaceId::from(space.as_str()), &title, icon.into())?;
            events.push(Event::Spaces(inner.space_views()));
            inner.persist_structure()
        })
    }

    /// Sets the colour that tints the space's sidebar (`#rrggbb`), or clears it.
    pub fn set_space_tint(&self, space: String, tint: Option<String>) -> Result<(), CoreError> {
        self.run(|inner, events| {
            inner
                .model
                .set_space_tint(&SpaceId::from(space.as_str()), tint.as_deref())?;
            events.push(Event::Spaces(inner.space_views()));
            inner.persist_structure()
        })
    }

    /// Folds the pinned list of the space away, or unfolds it.
    pub fn set_pinned_collapsed(&self, space: String, collapsed: bool) -> Result<(), CoreError> {
        self.run(|inner, events| {
            inner
                .model
                .set_pinned_collapsed(&SpaceId::from(space.as_str()), collapsed)?;
            events.push(Event::Spaces(inner.space_views()));
            inner.persist_structure()
        })
    }

    /// Moves a space to `index` in the list of spaces.
    pub fn move_space(&self, space: String, index: u32) -> Result<(), CoreError> {
        self.run(|inner, events| {
            inner
                .model
                .move_space(&SpaceId::from(space.as_str()), index as usize)?;
            events.push(Event::Spaces(inner.space_views()));
            inner.persist_structure()
        })
    }

    /// Deletes a space: its tabs and folders, its tabs that are open (the
    /// engine bridge is told to close them) and, when no other space shares
    /// it, the identity with its favorites, history, logins and zoom. The
    /// engine side still has to forget what Gecko keeps for the container.
    pub fn delete_space(&self, space: String) -> Result<DeletedSpace, CoreError> {
        self.run(|inner, events| {
            let windows: Vec<(LiveTabId, WindowId)> = inner
                .model
                .live_tabs()
                .into_iter()
                .map(|tab| (tab.id, tab.window))
                .collect();
            let removed = inner.model.delete_space(&SpaceId::from(space.as_str()))?;
            for live in removed.closed {
                if let Some((_, window)) = windows.iter().find(|(id, _)| *id == live) {
                    events.push(Event::CloseTab {
                        window: window.0.clone(),
                        live_tab: live.0,
                    });
                }
            }
            let last = inner.store.get_meta(META_LAST_SPACE)?;
            let fallback = removed
                .moved_windows
                .first()
                .map(|(_, space)| space.clone());
            for (window, space) in removed.moved_windows {
                events.push(Event::ActiveSpace {
                    window: window.0,
                    space: space.0,
                });
            }
            if last.as_deref() == Some(space.as_str()) {
                if let Some(fallback) =
                    fallback.or_else(|| inner.model.spaces().first().map(|space| space.id.clone()))
                {
                    inner.store.set_meta(META_LAST_SPACE, fallback.as_str())?;
                }
            }
            let user_context_id = removed
                .identity
                .as_ref()
                .map(|identity| identity.gecko_user_context_id)
                .unwrap_or_default();
            if let Some(identity) = &removed.identity {
                inner.history.clear(&identity.id.0)?;
                inner.logins.clear(&identity.id.0)?;
            }
            inner.store.set_meta(
                META_NEXT_CONTEXT,
                &inner.model.next_user_context_id().to_string(),
            )?;
            events.push(Event::Spaces(inner.space_views()));
            inner.persist_removals()?;
            Ok(DeletedSpace {
                user_context_id: if removed.identity.is_some() {
                    user_context_id
                } else {
                    0
                },
                identity_removed: removed.identity.is_some(),
            })
        })
    }

    pub fn open_window(&self, window: String) -> Result<(), CoreError> {
        self.run(|inner, _| {
            inner.model.open_window(WindowId::from(window));
            Ok(())
        })
    }

    pub fn close_window(&self, window: String) -> Result<(), CoreError> {
        self.run(|inner, _| {
            inner.model.close_window(&WindowId::from(window));
            Ok(())
        })
    }

    pub fn switch_space(&self, window: String, space: String) -> Result<(), CoreError> {
        self.run(|inner, events| {
            inner.model.switch_space(
                &WindowId::from(window.as_str()),
                &SpaceId::from(space.as_str()),
            )?;
            events.push(Event::ActiveSpace {
                window,
                space: space.clone(),
            });
            inner.store.set_meta(META_LAST_SPACE, &space)?;
            Ok(())
        })
    }

    /// Opens a new tab at `url` in the space's Today list and asks the engine
    /// bridge to create it in the space's container. Returns the live tab id.
    pub fn open_url(
        &self,
        window: String,
        space: String,
        url: String,
    ) -> Result<String, CoreError> {
        self.run(|inner, events| {
            let target = inner.space(&space)?;
            let (live, ops) =
                inner
                    .model
                    .open_url(&WindowId::from(window.as_str()), &target.id, &url)?;
            Inner::tree_event(&ops, events);
            let node = inner
                .model
                .live_tab(&live)
                .map(|tab| tab.node.0.clone())
                .unwrap_or_default();
            events.push(Event::OpenTab {
                window,
                space,
                user_context_id: inner.user_context_id(&target),
                url,
                live_tab: live.0.clone(),
                node,
            });
            inner.persist_ops(&ops)?;
            Ok(live.0)
        })
    }

    /// Opens a saved tab, or selects it if it is already open in the window.
    pub fn open_node(
        &self,
        window: String,
        space: String,
        node: String,
    ) -> Result<String, CoreError> {
        self.run(|inner, events| {
            let target = inner.space(&space)?;
            let window_id = WindowId::from(window.as_str());
            let node_id = NodeId::from(node.as_str());
            let existing = inner
                .model
                .live_tabs()
                .into_iter()
                .find(|tab| tab.node == node_id && tab.window == window_id);
            let live = inner.model.open_node(&window_id, &target.id, &node_id)?;
            if existing.is_some() {
                events.push(Event::SelectTab {
                    window,
                    live_tab: live.0.clone(),
                });
            } else {
                let url = match inner.model.node(&node_id).map(|n| &n.kind) {
                    Some(NodeKind::Tab(tab)) => tab.url.clone(),
                    _ => String::new(),
                };
                events.push(Event::OpenTab {
                    window,
                    space,
                    user_context_id: inner.user_context_id(&target),
                    url,
                    live_tab: live.0.clone(),
                    node: node_id.0.clone(),
                });
            }
            Ok(live.0)
        })
    }

    pub fn pin_tab(
        &self,
        window: String,
        live_tab: String,
        into: String,
        index: u32,
    ) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let live = LiveTabId::from(live_tab.as_str());
            match inner.model.live_tab(&live) {
                Some(tab) if tab.window.as_str() == window => {}
                _ => {
                    return Err(CoreError::NotFound {
                        what: format!("live tab {live_tab}"),
                    })
                }
            }
            let ops = inner
                .model
                .pin_live_tab(&live, &NodeId::from(into), index as usize)?;
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)
        })
    }

    pub fn unpin_node(&self, node: String, space: String) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let ops = inner
                .model
                .unpin_node(&NodeId::from(node), &SpaceId::from(space))?;
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)
        })
    }

    pub fn move_node(&self, node: String, new_parent: String, index: u32) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let ops = inner.model.move_node(
                &NodeId::from(node),
                &NodeId::from(new_parent),
                index as usize,
            )?;
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)
        })
    }

    pub fn create_folder(
        &self,
        parent: String,
        title: String,
        index: u32,
    ) -> Result<String, CoreError> {
        self.run(|inner, events| {
            let (id, ops) =
                inner
                    .model
                    .insert_folder(&NodeId::from(parent), index as usize, &title)?;
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)?;
            Ok(id.0)
        })
    }

    /// Puts back the row removed last, with what was below it. Returns its id, or
    /// nothing when there is nothing to put back.
    pub fn undo_remove(&self) -> Result<Option<String>, CoreError> {
        self.run(|inner, events| {
            let Some((id, ops)) = inner.model.undo_remove()? else {
                return Ok(None);
            };
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)?;
            Ok(Some(id.0))
        })
    }

    pub fn rename_node(&self, node: String, title: String) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let ops = inner.model.rename_node(&NodeId::from(node), &title)?;
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)
        })
    }

    pub fn set_collapsed(&self, node: String, collapsed: bool) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let ops = inner.model.set_collapsed(&NodeId::from(node), collapsed)?;
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)
        })
    }

    /// Removes a node and its subtree; the engine bridge is told to close any
    /// tab that was open on it.
    pub fn remove_node(&self, node: String) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let windows: Vec<(LiveTabId, WindowId)> = inner
                .model
                .live_tabs()
                .into_iter()
                .map(|tab| (tab.id, tab.window))
                .collect();
            let (ops, closed) = inner.model.remove_node(&NodeId::from(node))?;
            Inner::tree_event(&ops, events);
            for live in closed {
                if let Some((_, window)) = windows.iter().find(|(id, _)| *id == live) {
                    events.push(Event::CloseTab {
                        window: window.0.clone(),
                        live_tab: live.0,
                    });
                }
            }
            inner.persist_ops(&ops)
        })
    }

    pub fn query_command_bar(
        &self,
        space: String,
        text: String,
    ) -> Result<Vec<Suggestion>, CoreError> {
        self.run(|inner, _| {
            let space = inner.space(&space)?;
            let mut candidates = Vec::new();
            for (root, kind) in inner.roots(&space) {
                inner.candidates(&root, kind, &mut candidates);
            }
            let tokens: Vec<String> = text.split_whitespace().map(str::to_lowercase).collect();
            if !tokens.is_empty() {
                let now = SystemEnv.now_ms();
                let pages =
                    inner
                        .history
                        .search(&space.identity_id.0, &tokens, HISTORY_CANDIDATES, now)?;
                candidates.extend(pages.into_iter().map(|page| Candidate {
                    id: String::new(),
                    kind: CandidateKind::History,
                    title: page.title,
                    url: page.url,
                    is_open: false,
                    last_active_at: page.last_visit,
                    weight: (page.frecency / 2.0).round() as i32,
                }));
            }
            let engine = &default_engines()[0];
            Ok(
                core_search::suggest(&text, &candidates, engine, SUGGESTION_LIMIT)
                    .into_iter()
                    .map(|s| Suggestion {
                        kind: match s.kind {
                            core_search::SuggestionKind::Pinned => SuggestionKind::Pinned,
                            core_search::SuggestionKind::Today => SuggestionKind::Today,
                            core_search::SuggestionKind::History => SuggestionKind::History,
                            core_search::SuggestionKind::Url => SuggestionKind::Url,
                            core_search::SuggestionKind::Search => SuggestionKind::Search,
                        },
                        title: s.title,
                        url: s.url,
                        node: s.id,
                        is_open: s.is_open,
                    })
                    .collect(),
            )
        })
    }

    pub fn import_arc(&self, path: String) -> Result<ImportReport, CoreError> {
        self.run(|inner, events| {
            let report = core_store::import_arc_file(&mut inner.model, Path::new(&path))?;
            events.push(Event::Spaces(inner.space_views()));
            let saved = inner.store.save_all(&inner.model);
            inner.dirty = saved.is_err();
            saved?;
            Ok(ImportReport {
                identities: report.identities as u32,
                spaces: report.spaces as u32,
                folders: report.folders as u32,
                tabs: report.tabs as u32,
                favorites: report.favorites as u32,
                warnings: report.warnings,
            })
        })
    }

    /// Engine report: the engine opened a tab on its own (`window.open`, a
    /// `target=_blank` link). The core records it in Today, but does not ask
    /// the bridge to open anything. Returns the live tab id.
    pub fn on_tab_opened(
        &self,
        window: String,
        space: String,
        url: String,
    ) -> Result<OpenedTab, CoreError> {
        self.run(|inner, events| {
            let target = inner.space(&space)?;
            let (live, ops) = inner
                .model
                .open_url(&WindowId::from(window), &target.id, &url)?;
            Inner::tree_event(&ops, events);
            let node = inner
                .model
                .live_tab(&live)
                .map(|tab| tab.node.0.clone())
                .unwrap_or_default();
            inner.persist_ops(&ops)?;
            Ok(OpenedTab {
                live_tab: live.0,
                node,
            })
        })
    }

    /// Engine report: a live tab's favicon changed; `None` clears it.
    pub fn on_favicon(&self, live_tab: String, icon: Option<String>) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let ops = inner
                .model
                .set_tab_icon(&LiveTabId::from(live_tab), icon.as_deref())?;
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)
        })
    }

    /// Engine report: a top-level navigation finished in a live tab.
    pub fn on_navigation(
        &self,
        live_tab: String,
        url: String,
        title: String,
        transition: Transition,
    ) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let live = LiveTabId::from(live_tab);
            let ops = inner.model.navigated(&live, &url, &title)?;
            Inner::tree_event(&ops, events);
            let saved = inner.persist_ops(&ops);
            // History is kept for the tab's identity only, and is best effort:
            // a failure here must not undo the tree change above.
            if let Some(identity) = inner.identity_of_live_tab(&live) {
                let now = SystemEnv.now_ms();
                let _ = match transition {
                    Transition::Typed => inner
                        .history
                        .record_visit(&identity, &url, &title, now, true),
                    Transition::Link | Transition::Redirect => inner
                        .history
                        .record_visit(&identity, &url, &title, now, false),
                    _ => inner.history.set_title(&identity, &url, &title),
                };
            }
            saved
        })
    }

    /// Makes the page a pinned tab or favorite is on the page it starts from.
    pub fn repin_tab(&self, live_tab: String, url: String, title: String) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let ops = inner
                .model
                .repin(&LiveTabId::from(live_tab), &url, &title)?;
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)
        })
    }

    /// How many pages the space's identity has in its history.
    pub fn history_count(&self, space: String) -> Result<u64, CoreError> {
        self.run(|inner, _| {
            let space = inner.space(&space)?;
            Ok(inner.history.count(&space.identity_id.0)?)
        })
    }

    /// Forgets the history of the space's identity; returns how many pages went.
    pub fn clear_history(&self, space: String) -> Result<u32, CoreError> {
        self.run(|inner, _| {
            let space = inner.space(&space)?;
            Ok(inner.history.clear(&space.identity_id.0)? as u32)
        })
    }

    /// Every login of the container's identity.
    pub fn logins_all(&self, user_context_id: u32) -> Result<Vec<LoginRecord>, CoreError> {
        self.run(|inner, _| {
            let identity = inner.identity_for_context(user_context_id)?;
            Ok(inner
                .logins
                .all(&identity)?
                .into_iter()
                .map(Into::into)
                .collect())
        })
    }

    /// The container's logins whose origin is one of `origins`.
    pub fn logins_for_origins(
        &self,
        user_context_id: u32,
        origins: Vec<String>,
    ) -> Result<Vec<LoginRecord>, CoreError> {
        self.run(|inner, _| {
            let identity = inner.identity_for_context(user_context_id)?;
            Ok(inner
                .logins
                .for_origins(&identity, &origins)?
                .into_iter()
                .map(Into::into)
                .collect())
        })
    }

    pub fn logins_count(&self, user_context_id: u32) -> Result<u64, CoreError> {
        self.run(|inner, _| {
            let identity = inner.identity_for_context(user_context_id)?;
            Ok(inner.logins.count(&identity)?)
        })
    }

    pub fn login_add(&self, user_context_id: u32, login: LoginRecord) -> Result<(), CoreError> {
        self.run(|inner, _| {
            let identity = inner.identity_for_context(user_context_id)?;
            Ok(inner.logins.add(&identity, &login.into())?)
        })
    }

    pub fn login_update(&self, user_context_id: u32, login: LoginRecord) -> Result<(), CoreError> {
        self.run(|inner, _| {
            let identity = inner.identity_for_context(user_context_id)?;
            Ok(inner.logins.update(&identity, &login.into())?)
        })
    }

    pub fn login_remove(&self, user_context_id: u32, guid: String) -> Result<(), CoreError> {
        self.run(|inner, _| {
            let identity = inner.identity_for_context(user_context_id)?;
            Ok(inner.logins.remove(&identity, &guid)?)
        })
    }

    pub fn login_record_use(
        &self,
        user_context_id: u32,
        guid: String,
        time_ms: i64,
    ) -> Result<(), CoreError> {
        self.run(|inner, _| {
            let identity = inner.identity_for_context(user_context_id)?;
            Ok(inner.logins.record_use(&identity, &guid, time_ms)?)
        })
    }

    /// Forgets the logins of the container's identity.
    pub fn logins_clear(&self, user_context_id: u32) -> Result<u32, CoreError> {
        self.run(|inner, _| {
            let identity = inner.identity_for_context(user_context_id)?;
            Ok(inner.logins.clear(&identity)? as u32)
        })
    }

    /// Engine report: the user closed a live tab. A Today tab's node goes with it.
    pub fn on_tab_closed(&self, live_tab: String) -> Result<(), CoreError> {
        self.run(|inner, events| {
            let ops = inner.model.close_live_tab(&LiveTabId::from(live_tab))?;
            Inner::tree_event(&ops, events);
            inner.persist_ops(&ops)
        })
    }
}
