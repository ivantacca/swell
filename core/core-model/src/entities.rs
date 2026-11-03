/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::ids::{IdentityId, LiveTabId, NodeId, SpaceId, WindowId};
use serde::{Deserialize, Serialize};

/// Highest `gecko_user_context_id` the core hands out; `u32::MAX` is reserved
/// by Gecko for the WebExtension storage identity and 0 is the default
/// context, which never holds web content.
pub const MAX_USER_CONTEXT_ID: u32 = u32::MAX - 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub id: IdentityId,
    pub name: String,
    pub gecko_user_context_id: u32,
    pub profile_dir_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Icon {
    Symbol(String),
    Emoji(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Space {
    pub id: SpaceId,
    pub title: String,
    pub icon: Icon,
    /// The colour that tints the sidebar of the space, `#rrggbb`.
    pub tint: Option<String>,
    /// Whether the pinned list is folded away under the space's name.
    pub pinned_collapsed: bool,
    pub identity_id: IdentityId,
    pub pinned_root: NodeId,
    pub today_root: NodeId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RootKind {
    Pinned(SpaceId),
    Today(SpaceId),
    Favorites(IdentityId),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabData {
    pub url: String,
    pub title: String,
    pub custom_title: Option<String>,
    pub icon: Option<String>,
    pub last_active_at: i64,
    pub muted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeKind {
    Root(RootKind),
    Folder { title: String, collapsed: bool },
    Tab(TabData),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub parent_id: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_device: String,
    pub kind: NodeKind,
}

/// A tab currently open in a window; never persisted or synced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveTab {
    pub id: LiveTabId,
    pub window: WindowId,
    pub space: SpaceId,
    pub node: NodeId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub id: WindowId,
    pub active_space: Option<SpaceId>,
}
