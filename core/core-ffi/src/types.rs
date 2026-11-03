/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The records, enums and errors that cross the FFI, and their conversions
//! from the model. Identifiers are opaque strings; timestamps are Unix epoch
//! milliseconds.

use core_model as model;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Icon {
    Symbol { name: String },
    Emoji { glyph: String },
}

impl From<&model::Icon> for Icon {
    fn from(icon: &model::Icon) -> Self {
        match icon {
            model::Icon::Symbol(name) => Icon::Symbol { name: name.clone() },
            model::Icon::Emoji(glyph) => Icon::Emoji {
                glyph: glyph.clone(),
            },
        }
    }
}

impl From<Icon> for model::Icon {
    fn from(icon: Icon) -> Self {
        match icon {
            Icon::Symbol { name } => model::Icon::Symbol(name),
            Icon::Emoji { glyph } => model::Icon::Emoji(glyph),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Transition {
    Typed,
    Link,
    Reload,
    Back,
    Forward,
    Redirect,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NodeKindView {
    Tab {
        url: String,
        title: String,
        custom_title: Option<String>,
        icon: Option<String>,
        muted: bool,
    },
    Folder {
        title: String,
        collapsed: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NodeView {
    pub id: String,
    pub kind: NodeKindView,
    pub updated_at: i64,
}

impl NodeView {
    /// Roots are never shown as rows, so they have no view.
    pub(crate) fn of(node: &model::Node) -> Option<Self> {
        let kind = match &node.kind {
            model::NodeKind::Tab(tab) => NodeKindView::Tab {
                url: tab.url.clone(),
                title: tab.title.clone(),
                custom_title: tab.custom_title.clone(),
                icon: tab.icon.clone(),
                muted: tab.muted,
            },
            model::NodeKind::Folder { title, collapsed } => NodeKindView::Folder {
                title: title.clone(),
                collapsed: *collapsed,
            },
            model::NodeKind::Root(_) => return None,
        };
        Some(Self {
            id: node.id.0.clone(),
            kind,
            updated_at: node.updated_at,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct SpaceView {
    pub id: String,
    pub title: String,
    pub icon: Icon,
    /// `#rrggbb`, or none.
    pub tint: Option<String>,
    /// The pinned list is folded away.
    pub pinned_collapsed: bool,
    pub identity_id: String,
    /// The Gecko container of this space; never 0.
    pub user_context_id: u32,
    pub pinned_root: String,
    pub today_root: String,
    pub favorites_root: String,
}

/// What deleting a space left for the engine side to clean up.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DeletedSpace {
    /// The container of the space; never given to another space again.
    pub user_context_id: u32,
    /// False when another space shares the identity and so the container.
    pub identity_removed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ChildList {
    pub parent: String,
    pub ids: Vec<String>,
}

/// Everything shown for one space: its Pinned and Today trees and the
/// Favorites of its identity. `children` also lists the roots.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TreeSnapshot {
    pub nodes: Vec<NodeView>,
    pub children: Vec<ChildList>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TreeOp {
    Inserted {
        node: NodeView,
        parent: String,
        index: u32,
    },
    Removed {
        id: String,
    },
    Moved {
        id: String,
        parent: String,
        index: u32,
    },
    Updated {
        node: NodeView,
    },
}

impl TreeOp {
    pub(crate) fn of(op: &model::TreeOp) -> Option<Self> {
        Some(match op {
            model::TreeOp::Inserted {
                node,
                parent,
                index,
            } => TreeOp::Inserted {
                node: NodeView::of(node)?,
                parent: parent.0.clone(),
                index: *index,
            },
            model::TreeOp::Removed { id } => TreeOp::Removed { id: id.0.clone() },
            model::TreeOp::Moved { id, parent, index } => TreeOp::Moved {
                id: id.0.clone(),
                parent: parent.0.clone(),
                index: *index,
            },
            model::TreeOp::Updated { node } => TreeOp::Updated {
                node: NodeView::of(node)?,
            },
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TreeDiff {
    pub ops: Vec<TreeOp>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum SuggestionKind {
    Pinned,
    Today,
    History,
    Url,
    Search,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct Suggestion {
    pub kind: SuggestionKind,
    pub title: String,
    pub url: String,
    pub node: Option<String>,
    pub is_open: bool,
}

/// A tab the engine opened on its own, and the node recording it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct OpenedTab {
    pub live_tab: String,
    pub node: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct ImportReport {
    pub identities: u32,
    pub spaces: u32,
    pub folders: u32,
    pub tabs: u32,
    pub favorites: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CoreError {
    #[error("invariant: {reason}")]
    Invariant { reason: String },
    #[error("not found: {what}")]
    NotFound { what: String },
    #[error("storage: {reason}")]
    Storage { reason: String },
    #[error("import: {reason}")]
    Import { reason: String },
}

impl From<model::ModelError> for CoreError {
    fn from(error: model::ModelError) -> Self {
        match error {
            model::ModelError::NotFound(what) => CoreError::NotFound { what },
            model::ModelError::Invariant(reason) => CoreError::Invariant { reason },
        }
    }
}

impl From<core_logins::LoginsError> for CoreError {
    fn from(error: core_logins::LoginsError) -> Self {
        match error {
            core_logins::LoginsError::NotFound(what) => CoreError::NotFound { what },
            other => CoreError::Storage {
                reason: other.to_string(),
            },
        }
    }
}

/// A saved login. The user name and password are encrypted by the caller.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LoginRecord {
    pub guid: String,
    pub origin: String,
    pub form_action_origin: Option<String>,
    pub http_realm: Option<String>,
    pub username_field: String,
    pub password_field: String,
    pub encrypted_username: String,
    pub encrypted_password: String,
    pub time_created: i64,
    pub time_last_used: i64,
    pub time_password_changed: i64,
    pub times_used: u32,
}

impl From<core_logins::Login> for LoginRecord {
    fn from(login: core_logins::Login) -> Self {
        Self {
            guid: login.guid,
            origin: login.origin,
            form_action_origin: login.form_action_origin,
            http_realm: login.http_realm,
            username_field: login.username_field,
            password_field: login.password_field,
            encrypted_username: login.encrypted_username,
            encrypted_password: login.encrypted_password,
            time_created: login.time_created,
            time_last_used: login.time_last_used,
            time_password_changed: login.time_password_changed,
            times_used: login.times_used,
        }
    }
}

impl From<LoginRecord> for core_logins::Login {
    fn from(record: LoginRecord) -> Self {
        Self {
            guid: record.guid,
            origin: record.origin,
            form_action_origin: record.form_action_origin,
            http_realm: record.http_realm,
            username_field: record.username_field,
            password_field: record.password_field,
            encrypted_username: record.encrypted_username,
            encrypted_password: record.encrypted_password,
            time_created: record.time_created,
            time_last_used: record.time_last_used,
            time_password_changed: record.time_password_changed,
            times_used: record.times_used,
        }
    }
}

impl From<core_history::HistoryError> for CoreError {
    fn from(error: core_history::HistoryError) -> Self {
        CoreError::Storage {
            reason: error.to_string(),
        }
    }
}

impl From<core_store::StoreError> for CoreError {
    fn from(error: core_store::StoreError) -> Self {
        match error {
            core_store::StoreError::Model(inner) => inner.into(),
            other => CoreError::Storage {
                reason: other.to_string(),
            },
        }
    }
}

impl From<core_store::ImportError> for CoreError {
    fn from(error: core_store::ImportError) -> Self {
        match error {
            core_store::ImportError::Model(inner) => inner.into(),
            other => CoreError::Import {
                reason: other.to_string(),
            },
        }
    }
}

/// Events from the core to the window UI and the engine bridge. Callbacks run
/// on the JS main thread and never block the core.
#[uniffi::export(callback_interface)]
pub trait CoreListener: Send + Sync {
    fn on_tree_changed(&self, diff: TreeDiff);
    fn on_spaces_changed(&self, spaces: Vec<SpaceView>);
    fn on_active_space_changed(&self, window: String, space: String);
    /// The engine bridge must create a tab bound to `user_context_id`.
    fn on_open_tab(
        &self,
        window: String,
        space: String,
        user_context_id: u32,
        url: String,
        live_tab: String,
        node: String,
    );
    fn on_select_tab(&self, window: String, live_tab: String);
    fn on_close_tab(&self, window: String, live_tab: String);
}
