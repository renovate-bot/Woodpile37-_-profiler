/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import * as React from 'react';
import { MenuItem } from '@firefox-devtools/react-contextmenu';
import { Localized } from '@fluent/react';

import { ContextMenu } from './ContextMenu';
import explicitConnect from 'firefox-profiler/utils/connect';
import { parseFileNameFromSymbolication } from 'firefox-profiler/utils/special-paths';
import {
  funcHasDirectRecursiveCall,
  funcHasRecursiveCall,
} from 'firefox-profiler/profile-logic/transforms';
import { getFunctionName } from 'firefox-profiler/profile-logic/function-info';
import {
  getBottomBoxInfoForCallNode,
  getOriginAnnotationForFunc,
} from 'firefox-profiler/profile-logic/profile-data';
import { getCategories } from 'firefox-profiler/selectors';

import copy from 'copy-to-clipboard';
import {
  addTransformToStack,
  addCollapseResourceTransformToStack,
  expandAllCallNodeDescendants,
  updateBottomBoxContentsAndMaybeOpen,
  setContextMenuVisibility,
} from 'firefox-profiler/actions/profile-view';
import {
  getSelectedTab,
  getImplementationFilter,
  getInvertCallstack,
} from 'firefox-profiler/selectors/url-state';
import { getRightClickedCallNodeInfo } from 'firefox-profiler/selectors/right-clicked-call-node';
import { getThreadSelectorsFromThreadsKey } from 'firefox-profiler/selectors/per-thread';
import { oneLine } from 'common-tags';

import {
  convertToTransformType,
  assertExhaustiveCheck,
} from 'firefox-profiler/utils/flow';

import { getShouldDisplaySearchfox } from 'firefox-profiler/selectors/profile';

import type {
  TransformType,
  ImplementationFilter,
  IndexIntoCallNodeTable,
  IndexIntoFuncTable,
  CallNodeInfo,
  CallNodePath,
  Thread,
  ThreadsKey,
  CategoryList,
} from 'firefox-profiler/types';

import type { TabSlug } from 'firefox-profiler/app-logic/tabs-handling';
import type { ConnectedProps } from 'firefox-profiler/utils/connect';

type StateProps = {|
  +thread: Thread | null,
  +threadsKey: ThreadsKey | null,
  +categories: CategoryList,
  +callNodeInfo: CallNodeInfo | null,
  +rightClickedCallNodePath: CallNodePath | null,
  +rightClickedCallNodeIndex: IndexIntoCallNodeTable | null,
  +implementation: ImplementationFilter,
  +inverted: boolean,
  +selectedTab: TabSlug,
  +displaySearchfox: boolean,
|};

type DispatchProps = {|
  +addTransformToStack: typeof addTransformToStack,
  +addCollapseResourceTransformToStack: typeof addCollapseResourceTransformToStack,
  +expandAllCallNodeDescendants: typeof expandAllCallNodeDescendants,
  +updateBottomBoxContentsAndMaybeOpen: typeof updateBottomBoxContentsAndMaybeOpen,
  +setContextMenuVisibility: typeof setContextMenuVisibility,
|};

type Props = ConnectedProps<{||}, StateProps, DispatchProps>;

import './CallNodeContextMenu.css';

class CallNodeContextMenuImpl extends React.PureComponent<Props> {
  _hidingTimeout: TimeoutID | null = null;

  // Using setTimeout here is a bit complex, but is necessary to make the menu
  // work fine when we want to display it somewhere when it's already open
  // somewhere else.
  // This is the order of events in such a situation:
  // 0. The menu is open somewhere, it means the user right clicked somewhere
  //     previously, and as a result some node has the "right clicked" status.
  // 1. The user right clicks on another node. This is actually happening in
  //    several events, the first event is "mousedown": this is where our own
  //    components react for right click (both our TreeView and our charts)
  //    and thus this is when the "right clicked" item is set in our store. BTW
  //    this triggers a rerender of this component.
  // 2. Then the event "mouseup" happens but we don't do anything for it for right
  //    clicks.
  // 3. Then the event "contextmenu" is triggered. This is the event that the
  //    context menu library reacts to: first it closes the previous menu, then
  //    opens the new one. This means that `_onHide` is called first for the
  //    first menu, then `_onShow` for the second menu.
  //    The problem here is that the call to `setContextMenuVisibility` we do in
  //    `onHide` resets the value for the "right clicked" item. This is normally
  //    what we want when the user closes the menu, but this case where the menu
  //    is still open but for another node, we don't want to reset this value
  //    which was set earlier when handling the "mousedown" event.
  //    To avoid this problem we use this `setTimeout` call to delay the reset
  //    just a bit, just in case we get a `_onShow` call right after that.
  _onShow = () => {
    clearTimeout(this._hidingTimeout);
    this.props.setContextMenuVisibility(true);
  };

  _onHide = () => {
    this._hidingTimeout = setTimeout(() => {
      this._hidingTimeout = null;
      this.props.setContextMenuVisibility(false);
    });
  };

  _getFunctionName(): string {
    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      throw new Error(
        "The context menu assumes there is a selected call node and there wasn't one."
      );
    }

    const {
      callNodeIndex,
      thread: { stringTable, funcTable },
      callNodeInfo: { callNodeTable },
    } = rightClickedCallNodeInfo;

    const funcIndex = callNodeTable.func[callNodeIndex];
    const isJS = funcTable.isJS[funcIndex];
    const stringIndex = funcTable.name[funcIndex];
    const functionCall = stringTable.getString(stringIndex);
    const name = isJS ? functionCall : getFunctionName(functionCall);
    return name;
  }

  lookupFunctionOnSearchfox(): void {
    const name = this._getFunctionName();
    window.open(
      `https://searchfox.org/mozilla-central/search?q=${encodeURIComponent(
        name
      )}`,
      '_blank'
    );
  }

  copyFunctionName(): void {
    copy(this._getFunctionName());
  }

  _getFilePath(): string | null {
    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      throw new Error(
        "The context menu assumes there is a selected call node and there wasn't one."
      );
    }

    const {
      callNodeIndex,
      thread: { stringTable, funcTable },
      callNodeInfo: { callNodeTable },
    } = rightClickedCallNodeInfo;

    const funcIndex = callNodeTable.func[callNodeIndex];
    const stringIndex = funcTable.fileName[funcIndex];
    if (stringIndex === null) {
      return null;
    }
    return stringTable.getString(stringIndex);
  }

  showFile(): void {
    const { updateBottomBoxContentsAndMaybeOpen, selectedTab } = this.props;

    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      throw new Error(
        "The context menu assumes there is a selected call node and there wasn't one."
      );
    }

    const { callNodeIndex, thread, callNodeInfo } = rightClickedCallNodeInfo;
    const bottomBoxInfo = getBottomBoxInfoForCallNode(
      callNodeIndex,
      callNodeInfo,
      thread
    );
    updateBottomBoxContentsAndMaybeOpen(selectedTab, bottomBoxInfo);
  }

  copyUrl(): void {
    const url = this._getFilePath();
    if (url) {
      copy(url);
    }
  }

  copyStack(): void {
    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      throw new Error(
        "The context menu assumes there is a selected call node and there wasn't one."
      );
    }

    const {
      callNodeIndex,
      thread: { funcTable, resourceTable, stringTable },
      callNodeInfo: { callNodeTable },
    } = rightClickedCallNodeInfo;

    let stack = '';
    let curCallNodeIndex = callNodeIndex;

    do {
      // Match the style of MarkerContextMenu.js#convertStackToString which uses
      // square brackets around [file:line:column] info. This isn't provided by
      // getOriginAnnotationForFunc, so build the string in two parts:
      const funcIndex = callNodeTable.func[curCallNodeIndex];
      const funcNameIndex = funcTable.name[funcIndex];
      const funcName = stringTable.getString(funcNameIndex);
      const fileNameURL = getOriginAnnotationForFunc(
        funcIndex,
        funcTable,
        resourceTable,
        stringTable
      );
      stack += funcName + (fileNameURL ? ` [${fileNameURL}]\n` : '\n');
      curCallNodeIndex = callNodeTable.prefix[curCallNodeIndex];
    } while (curCallNodeIndex !== -1);

    copy(stack);
  }

  _handleClick = (event: SyntheticEvent<>, data: { type: string }): void => {
    const { type } = data;

    const transformType = convertToTransformType(type);
    if (transformType) {
      this.addTransformToStack(transformType);
      return;
    }

    switch (type) {
      case 'show-file':
        this.showFile();
        break;
      case 'searchfox':
        this.lookupFunctionOnSearchfox();
        break;
      case 'copy-function-name':
        this.copyFunctionName();
        break;
      case 'copy-url':
        this.copyUrl();
        break;
      case 'copy-stack':
        this.copyStack();
        break;
      case 'expand-all':
        this.expandAll();
        break;
      default:
        throw new Error(`Unknown type ${type}`);
    }
  };

  addTransformToStack(type: TransformType): void {
    const {
      addTransformToStack,
      addCollapseResourceTransformToStack,
      implementation,
      inverted,
    } = this.props;
    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      throw new Error(
        "The context menu assumes there is a selected call node and there wasn't one."
      );
    }

    const {
      threadsKey,
      callNodePath,
      thread,
      callNodeIndex,
      callNodeInfo: { callNodeTable },
    } = rightClickedCallNodeInfo;
    const selectedFunc = callNodePath[callNodePath.length - 1];
    const category = callNodeTable.category[callNodeIndex];
    switch (type) {
      case 'focus-subtree':
        addTransformToStack(threadsKey, {
          type: 'focus-subtree',
          callNodePath: callNodePath,
          implementation,
          inverted,
        });
        break;
      case 'focus-function':
        addTransformToStack(threadsKey, {
          type: 'focus-function',
          funcIndex: selectedFunc,
        });
        break;
      case 'merge-call-node':
        addTransformToStack(threadsKey, {
          type: 'merge-call-node',
          callNodePath: callNodePath,
          implementation,
        });
        break;
      case 'merge-function':
        addTransformToStack(threadsKey, {
          type: 'merge-function',
          funcIndex: selectedFunc,
        });
        break;
      case 'drop-function':
        addTransformToStack(threadsKey, {
          type: 'drop-function',
          funcIndex: selectedFunc,
        });
        break;
      case 'collapse-resource': {
        const { funcTable } = thread;
        const resourceIndex = funcTable.resource[selectedFunc];
        addCollapseResourceTransformToStack(
          threadsKey,
          resourceIndex,
          implementation
        );
        break;
      }
      case 'collapse-direct-recursion': {
        addTransformToStack(threadsKey, {
          type: 'collapse-direct-recursion',
          funcIndex: selectedFunc,
          implementation,
        });
        break;
      }
      case 'collapse-recursion': {
        addTransformToStack(threadsKey, {
          type: 'collapse-recursion',
          funcIndex: selectedFunc,
        });
        break;
      }
      case 'collapse-function-subtree': {
        addTransformToStack(threadsKey, {
          type: 'collapse-function-subtree',
          funcIndex: selectedFunc,
        });
        break;
      }
      case 'focus-category': {
        addTransformToStack(threadsKey, {
          type: 'focus-category',
          category,
        });
        break;
      }
      case 'filter-samples':
        throw new Error(
          "Filter samples transform can't be applied from the call node context menu."
        );
      default:
        assertExhaustiveCheck(type);
    }
  }

  expandAll(): void {
    const { expandAllCallNodeDescendants } = this.props;
    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      throw new Error(
        "The context menu assumes there is a selected call node and there wasn't one."
      );
    }

    const { threadsKey, callNodeIndex, callNodeInfo } =
      rightClickedCallNodeInfo;

    expandAllCallNodeDescendants(threadsKey, callNodeIndex, callNodeInfo);
  }

  getNameForSelectedResource(): string | null {
    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      throw new Error(
        "The context menu assumes there is a selected call node and there wasn't one."
      );
    }

    const {
      callNodePath,
      thread: { funcTable, stringTable, resourceTable },
    } = rightClickedCallNodeInfo;

    const funcIndex = callNodePath[callNodePath.length - 1];
    if (funcIndex === undefined) {
      return null;
    }
    const isJS = funcTable.isJS[funcIndex];

    if (isJS) {
      const fileNameIndex = funcTable.fileName[funcIndex];
      return fileNameIndex === null
        ? null
        : stringTable.getString(fileNameIndex);
    }
    const resourceIndex = funcTable.resource[funcIndex];
    if (resourceIndex === -1) {
      return null;
    }
    const resNameStringIndex = resourceTable.name[resourceIndex];
    return stringTable.getString(resNameStringIndex);
  }

  /**
   * Determine if this CallNode represent a recursive function call.
   */
  isRecursiveCall(
    funcHasRecursiveCall: (Thread, IndexIntoFuncTable) => boolean
  ): boolean {
    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      console.error(
        "The context menu assumes there is a selected call node and there wasn't one."
      );
      return false;
    }

    const { callNodePath, thread } = rightClickedCallNodeInfo;
    const funcIndex = callNodePath[callNodePath.length - 1];

    if (funcIndex === undefined) {
      return false;
    }

    // Do the easy thing first, see if this function was called by itself.
    if (callNodePath[callNodePath.length - 2] === funcIndex) {
      return true;
    }

    // Do a full check of the stackTable for recursion.
    return funcHasRecursiveCall(thread, funcIndex);
  }

  getRightClickedCallNodeInfo(): null | {|
    +thread: Thread,
    +threadsKey: ThreadsKey,
    +callNodeInfo: CallNodeInfo,
    +callNodePath: CallNodePath,
    +callNodeIndex: IndexIntoCallNodeTable,
  |} {
    const {
      thread,
      threadsKey,
      callNodeInfo,
      rightClickedCallNodePath,
      rightClickedCallNodeIndex,
    } = this.props;

    if (
      thread &&
      threadsKey !== null &&
      callNodeInfo &&
      rightClickedCallNodePath &&
      typeof rightClickedCallNodeIndex === 'number'
    ) {
      return {
        thread,
        threadsKey,
        callNodeInfo,
        callNodePath: rightClickedCallNodePath,
        callNodeIndex: rightClickedCallNodeIndex,
      };
    }

    return null;
  }

  renderContextMenuContents() {
    const { inverted, selectedTab, displaySearchfox, categories } = this.props;
    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      console.error(
        "The context menu assumes there is a selected call node and there wasn't one."
      );
      return <div />;
    }

    const {
      callNodeIndex,
      thread: { funcTable },
      callNodeInfo: { callNodeTable },
    } = rightClickedCallNodeInfo;

    const categoryIndex = callNodeTable.category[callNodeIndex];
    const funcIndex = callNodeTable.func[callNodeIndex];
    const isJS = funcTable.isJS[funcIndex];
    const hasCategory = categoryIndex !== -1;
    // This could be the C++ library, or the JS filename.
    const nameForResource = this.getNameForSelectedResource();
    const categoryName: string = hasCategory
      ? categories[categoryIndex].name
      : '';
    const showExpandAll = selectedTab === 'calltree';
    const filePath = this._getFilePath();
    const canCopyURL = isJS && filePath;
    const fileName =
      filePath &&
      parseFileNameFromSymbolication(filePath).path.match(/[^\\/]+$/)?.[0];
    return (
      <>
        {fileName ? (
          <>
            {this.renderMenuItemWithShortcut({
              l10nId: 'CallNodeContextMenu--show-file',
              l10nProps: {
                vars: { fileName },
                elems: { strong: <strong /> },
              },
              onClick: this._handleClick,
              data: { type: 'show-file' },
              shortcut: '⏎',
              content: `Show <strong>${fileName}</strong>`,
            })}
            <div className="react-contextmenu-separator" />
          </>
        ) : null}

        {this.renderTransformMenuItem({
          l10nId: 'CallNodeContextMenu--transform-merge-function',
          shortcut: 'm',
          icon: 'Merge',
          onClick: this._handleClick,
          transform: 'merge-function',
          title: '',
          content: 'Merge function',
        })}

        {inverted
          ? null
          : this.renderTransformMenuItem({
              l10nId: 'CallNodeContextMenu--transform-merge-call-node',
              shortcut: 'M',
              icon: 'Merge',
              onClick: this._handleClick,
              transform: 'merge-call-node',
              title: '',
              content: 'Merge node only',
            })}

        {this.renderTransformMenuItem({
          l10nId: inverted
            ? 'CallNodeContextMenu--transform-focus-function-inverted'
            : 'CallNodeContextMenu--transform-focus-function',
          shortcut: 'f',
          icon: 'Focus',
          onClick: this._handleClick,
          transform: 'focus-function',
          title: '',
          content: inverted
            ? 'Focus on function (inverted)'
            : 'Focus on function',
        })}

        {this.renderTransformMenuItem({
          l10nId: 'CallNodeContextMenu--transform-focus-subtree',
          shortcut: 'F',
          icon: 'Focus',
          onClick: this._handleClick,
          transform: 'focus-subtree',
          title: '',
          content: 'Focus on subtree only',
        })}

        {hasCategory
          ? this.renderTransformMenuItem({
              l10nId: 'CallNodeContextMenu--transform-focus-category',
              l10nProps: {
                vars: { categoryName },
                elems: { strong: <strong /> },
              },
              shortcut: 'g',
              icon: 'Focus',
              onClick: this._handleClick,
              transform: 'focus-category',
              title: '',
              content: 'Focus on category',
            })
          : null}

        {this.renderTransformMenuItem({
          l10nId: 'CallNodeContextMenu--transform-collapse-function-subtree',
          shortcut: 'c',
          icon: 'Collapse',
          onClick: this._handleClick,
          transform: 'collapse-function-subtree',
          title: '',
          content: 'Collapse function',
        })}

        {nameForResource
          ? this.renderTransformMenuItem({
              l10nId: 'CallNodeContextMenu--transform-collapse-resource',
              l10nProps: {
                vars: { nameForResource: nameForResource },
                elems: { strong: <strong /> },
              },
              shortcut: 'C',
              icon: 'Collapse',
              onClick: this._handleClick,
              transform: 'collapse-resource',
              title: '',
              content: `Collapse <strong>${nameForResource}</strong>`,
            })
          : null}

        {this.isRecursiveCall(funcHasRecursiveCall)
          ? this.renderTransformMenuItem({
              l10nId: 'CallNodeContextMenu--transform-collapse-recursion',
              shortcut: 'r',
              icon: 'Collapse',
              onClick: this._handleClick,
              transform: 'collapse-recursion',
              title: '',
              content: 'Collapse recursion',
            })
          : null}

        {this.isRecursiveCall((thread, funcIndex) =>
          funcHasDirectRecursiveCall(
            thread,
            this.props.implementation,
            funcIndex
          )
        )
          ? this.renderTransformMenuItem({
              l10nId:
                'CallNodeContextMenu--transform-collapse-direct-recursion-only',
              shortcut: 'R',
              icon: 'Collapse',
              onClick: this._handleClick,
              transform: 'collapse-direct-recursion',
              title: '',
              content: 'Collapse direct recursion only',
            })
          : null}

        {this.renderTransformMenuItem({
          l10nId: 'CallNodeContextMenu--transform-drop-function',
          shortcut: 'd',
          icon: 'Drop',
          onClick: this._handleClick,
          transform: 'drop-function',
          title: '',
          content: 'Drop samples with this function',
        })}

        <div className="react-contextmenu-separator" />

        {showExpandAll ? (
          <>
            {this.renderMenuItemWithShortcut({
              l10nId: 'CallNodeContextMenu--expand-all',
              onClick: this._handleClick,
              data: { type: 'expand-all' },
              shortcut: '*',
              content: 'Expand all',
            })}
            <div className="react-contextmenu-separator" />
          </>
        ) : null}
        {displaySearchfox ? (
          <Localized id="CallNodeContextMenu--searchfox">
            <MenuItem onClick={this._handleClick} data={{ type: 'searchfox' }}>
              Look up the function name on Searchfox
            </MenuItem>
          </Localized>
        ) : null}
        <Localized id="CallNodeContextMenu--copy-function-name">
          <MenuItem
            onClick={this._handleClick}
            data={{ type: 'copy-function-name' }}
          >
            Copy function name
          </MenuItem>
        </Localized>
        {canCopyURL ? (
          <Localized id="CallNodeContextMenu--copy-script-url">
            <MenuItem onClick={this._handleClick} data={{ type: 'copy-url' }}>
              Copy script URL
            </MenuItem>
          </Localized>
        ) : null}
        <Localized id="CallNodeContextMenu--copy-stack">
          <MenuItem onClick={this._handleClick} data={{ type: 'copy-stack' }}>
            Copy stack
          </MenuItem>
        </Localized>
      </>
    );
  }

  renderTransformMenuItem(props: {|
    +l10nId: string,
    +l10nProps?: mixed,
    +content: React.Node,
    +onClick: (event: SyntheticEvent<>, data: { type: string }) => void,
    +transform: string,
    +shortcut: string,
    +icon: string,
    +title: string,
  |}) {
    return (
      <MenuItem onClick={props.onClick} data={{ type: props.transform }}>
        <span
          className={`react-contextmenu-icon callNodeContextMenuIcon${props.icon}`}
        />
        <Localized
          id={props.l10nId}
          attrs={{ title: true }}
          {...props.l10nProps}
        >
          <DivWithTitle
            className="react-contextmenu-item-content"
            title={props.title}
          >
            {props.content}
          </DivWithTitle>
        </Localized>
        <kbd className="callNodeContextMenuShortcut">{props.shortcut}</kbd>
      </MenuItem>
    );
  }

  renderMenuItemWithShortcut(props: {|
    +l10nId: string,
    +l10nProps?: mixed,
    +content: React.Node,
    +onClick: (event: SyntheticEvent<>, data: { type: string }) => void,
    +shortcut: string,
    +data: { type: string },
  |}) {
    return (
      <MenuItem onClick={props.onClick} data={{ type: props.data.type }}>
        <Localized id={props.l10nId} {...props.l10nProps}>
          <div className="react-contextmenu-item-content">{props.content}</div>
        </Localized>
        <kbd className="callNodeContextMenuShortcut">{props.shortcut}</kbd>
      </MenuItem>
    );
  }

  render() {
    const rightClickedCallNodeInfo = this.getRightClickedCallNodeInfo();

    if (rightClickedCallNodeInfo === null) {
      return null;
    }

    return (
      <ContextMenu
        id="CallNodeContextMenu"
        className="callNodeContextMenu"
        onShow={this._onShow}
        onHide={this._onHide}
      >
        {this.renderContextMenuContents()}
      </ContextMenu>
    );
  }
}

export const CallNodeContextMenu = explicitConnect<
  {||},
  StateProps,
  DispatchProps
>({
  mapStateToProps: (state) => {
    const rightClickedCallNodeInfo = getRightClickedCallNodeInfo(state);

    let thread = null;
    let threadsKey = null;
    let callNodeInfo = null;
    let rightClickedCallNodePath = null;
    let rightClickedCallNodeIndex = null;

    if (rightClickedCallNodeInfo !== null) {
      const selectors = getThreadSelectorsFromThreadsKey(
        rightClickedCallNodeInfo.threadsKey
      );

      thread = selectors.getFilteredThread(state);
      threadsKey = rightClickedCallNodeInfo.threadsKey;
      callNodeInfo = selectors.getCallNodeInfo(state);
      rightClickedCallNodePath = rightClickedCallNodeInfo.callNodePath;
      rightClickedCallNodeIndex = selectors.getRightClickedCallNodeIndex(state);
    }

    return {
      thread,
      threadsKey,
      categories: getCategories(state),
      callNodeInfo,
      rightClickedCallNodePath,
      rightClickedCallNodeIndex,
      implementation: getImplementationFilter(state),
      inverted: getInvertCallstack(state),
      selectedTab: getSelectedTab(state),
      displaySearchfox: getShouldDisplaySearchfox(state),
    };
  },
  mapDispatchToProps: {
    addTransformToStack,
    addCollapseResourceTransformToStack,
    expandAllCallNodeDescendants,
    updateBottomBoxContentsAndMaybeOpen,
    setContextMenuVisibility,
  },
  component: CallNodeContextMenuImpl,
});

function DivWithTitle(props: {|
  +className?: string,
  +children: React.Node,
  +title: string,
|}) {
  return (
    <div className={props.className} title={oneLine`${props.title}`}>
      {props.children}
    </div>
  );
}
