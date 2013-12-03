/* Darkwind's Anti-Vandal Tool
 * Inspired by Lupin's Anti-Vandal Tool by [[User:Lupin]]
 * The RegEx generation function is from Lupin's Tool.
 * Some of the functionality for the auto-warn feature is borrowed from Twinkle ([[WP:TW]])
 *
 * License: GFDL 1.3 or later*, CC-BY-SA-3.0*, or EPL 1.0 (your choice)
 */

var AVT = new Object();
var AVTvandals = new Object();
var AVTconfig, AVTfilters;

AVT.onLoad=function(){
    mw.util.addPortletLink("p-tb", "//en.wikipedia.org/wiki/User:Darkwind/DAVT/Filter", "Darkwind's AVT");
    var pageTitle = mw.config.get("wgTitle");
    if (pageTitle.search("DAVT") == -1) return; //only run on pages containing the string DAVT

    // now that we know to run the tool, set default config if the user doesn't already have settings in their *.js file
    if (!AVTconfig) {
        AVTconfig = {
            batchDelay: 30, //in seconds, how often should a new batch of diffs be processed? default of 30 mimics Lupin's AVT
            diffDelay: 90, //in seconds, how old is the newest edit we'll check? this helps avoid showing edits that ClueBotNG is about to undo, for example. This replaces "unchanged after 4 updates" option from LAVT.
            readDelay: 250, //in milliseconds, how long should we wait in between API calls? Note that this is not a strict rate limit.
            namespaces: "0|2", //a string, delimited by pipe, for which namespaces we want to monitor. See [[Wikipedia:Namespace]] for the list.
            showTypes: "!minor|!bot", //a string, delimited by pipe, for which edits we want to monitor. prefix the type with a ! to hide those edits.
            editTypes: "edit|new", //a string, delimited by pipe, for the type of edits we want to monitor "edit|new" means both edits and new pages - completely remove types you don't want
            showByDefault: true, //show matching edits expanded by default? true=yes, show expanded, false=no, show them collapsed
            areYouThereTimeout: 60, //in minutes, how long before the tool stops and asks if you want to continue. 90 min. maximum, any higher value will be ignored.
            popTalkAfterRollback: false, //Do you want the vandals talk page to open in a popup/new tab after rollback?
            warningAge: 7, //in days, how long does a warning have to be before we consider it "stale" and start over?
            welcomeAnon: true, //welcome anonymous users (with welcome-anon-unconstructive) if talk page doesn't exist?
            welcomeReg: true //welcome registered users (with welcomevandal) when talk page doesn't exist?
        };
    }

    if (!AVTfilters) {
        AVTfilters = { //anyone matching active filters in this section is "whitelisted" from the tool, and their edits will not appear
            groupFilterOn: false, //filter based on user groups?
            groupFilter: ["sysop", "bureaucrat"], //a list of user groups to whitelist, notated as a JavaScript array of strings.
            //The list of user groups can be found at [[Special:ListUsers]] in the dropdown box, or at [[WP:RIGHTS]].
            editCountFilterOn: true, //filter based on user's edit count?
            editCountFilter: 200, //how many edits will exempt the user? 200 is default because that's enough to enroll in [[WP:CVUA]].
            titleFilters: [/[Ss]andbox/, /TWA/] //a list of regular expressions or strings we want to filter out of titles - if title matches, it won't be checked
        };
    }

     //the following item is required in the title filter list to prevent the bug in issue #18
     //since it is a bug fix, we don't keep it in the editable title filter list
    AVTfilters.titleFilters.push(/\.(css|js)/);

    mw.loader.load('mediawiki.action.history.diff'); //load the CSS required for diff-styling

    AVT.count = 0; //initialize the diff count
    AVT.whitelistCache = []; //and an array to cache our whitelist

    if (pageTitle.search("Filter") != -1) AVT.filterChanges(); //if page is DAVT/Filter, trigger Filter Changes procedure

    //obtain an edit token
    $.ajax({
        url: "/w/api.php",
        dataType: "JSON",
        data: { action: "query", prop: "info", format: "json", intoken: "edit", titles: "User:Darkwind/DAVT" },
        success: function (response) {
            AVT.editToken = response.query.pages["40938264"].edittoken;
        }
    });

    //TODO: Implement live spellcheck and watchlist
};

AVT.filterChanges=function(){
    if (!AVT.loadBadWords()) return 0; //first, load the "bad words" regex. if it fails, die.

    //next, set up the page
    //TODO: status indicator, *possibly* live checkboxes for options
    $("#mw-content-text").empty(); //blank the "page left blank" element
    $("#firstHeading span").text("Darkwind's Anti-Vandal Tool"); //Replace "Blank page" with the right heading
    $("#mw-content-text").append('<div id="DAVTcontent" style="line-height: 1.5em"></div>'); //add the empty DIV to contain all of our future output

    //Pause button
    var button = '<button id="AVTpause">Pause updates</button><br><hr>';
    $("#DAVTcontent").append(button);
    document.getElementById('AVTpause').addEventListener("click", AVT.pauseResume, false);

    //create a queue for diffs to download, as well as new pages
    pendingDiffs = new Queue();
    pendingNewPages = new Queue();

    //prepare the user-presence check timeout
    var aytt = AVTconfig.areYouThereTimeout; //for clarity's sake on the next line
    AVT.timeDelay = (((aytt > 90) || !aytt) ? 90 : aytt); //if the user's AYT-check is non-existent, 0, or set above 90, return 90 min.
    AVT.timeDelay = AVT.timeDelay * 60 * 1000; //the timeout function takes milliseconds, not minutes
    AVT.AYTtimer = setTimeout(AVT.rcTimeout, AVT.timeDelay); //stop the RC job after that time to prompt the user to continue

    //now, kick off the filter process
    AVT.rcDownloadFilter();

    //we're done here - the interval and timeout will take control
};

AVT.rcDownloadFilter=function(){
    if (AVT.paused) {
        console.info("AVT Paused");
        return; //abort if paused
    }

    if (AVT.rcStopSignal) {
        console.info("Script stopped.");
        return; //abort if stopped
    }

    AVT.rcIsRunning = 1;
    var time1 = new Date();
    var time2 = new Date();

    time2.setTime(time1.getTime() - (AVTconfig.diffDelay * 1000)); //we only want recent changes older than diffDelay
    var timestamp = time2.toISOString(); //so let's generate a timestamp for our API query

    //okay, let's build a URL for our API query
    var queryURL = "/w/api.php?action=query&list=recentchanges&format=json&rcdir=older&rcprop=ids|title&rclimit=100&rctoponly="; //this part won't change
    queryURL += "&rcshow=" + AVTconfig.showTypes + "&rctype=" + AVTconfig.editTypes + "&rcnamespace=" + AVTconfig.namespaces + "&rcstart=" + timestamp;
    if (AVT.rcLastTime) queryURL += "&rcend=" + AVT.rcLastTime; //is there a timestamp to end at?
    AVT.rcLastTime = timestamp; //set the end timestamp for the next round - preventing overlap and duplicate diffs
    //console.info(queryURL);

    $.ajax({ //pull the list of changes
        url: queryURL,
        dataType: "JSON",
        success: function (response) {
            var edits = response.query.recentchanges; //an array of recent edits, containing several things but most importantly the revision ID for each change (revid)
            response.query.recentchanges.forEach( function (props, ind, array) {
                var skip = 0;
                for (var filter = 0; filter < AVTfilters.titleFilters.length; filter++) {
                    if (props.title.search(AVTfilters.titleFilters[filter]) != -1) { //if the title matches the title filter, skip the queue
                        skip = 1;
                    }
                }
                if (!skip) { //if it didn't match the filter, queue it up
                    if (props.type == "new") pendingNewPages.enqueue(props.revid); //if the edit is a page creation, queue it up with new pages as they are handled differently
                            else pendingDiffs.enqueue(props.revid); //otherwise put it in the diff queue
                }
            });

            //process the new page queue
            if (!pendingNewPages.isEmpty()) AVT.processNewPageFilterDiff();

            //process the diff queue
            if (!pendingDiffs.isEmpty()) AVT.processFilterDiff();

            //do this again in diffDelay seconds unless we've received a stop signal
            if (!AVT.rcStopSignal) setTimeout(AVT.rcDownloadFilter, (AVTconfig.diffDelay * 1000));
                else console.info("Script stopped.");
            AVT.rcIsRunning = 0;
        }
    });
};

AVT.processNewPageFilterDiff = function() {
    if (AVT.paused) {
        console.info("AVT Paused");
        return; //abort if paused
    }

    if (AVT.rcStopSignal) {
        console.info("Script stopped.");
        return; //abort if stopped
    }

    if (pendingNewPages.isEmpty()) return; //abort if the queue is now empty

    var revid = pendingNewPages.dequeue(); //pop the top revision off the new page queue
    var title, content, summary, timestamp, editor, matches, latestrev;
    timestamp = new Date();

    $.ajax({ //retrieve information about the page -- specifically, we're looking to see if this is still the latest revision.  If it isn't, let's not waste resources downloading the diff.
        url: "/w/api.php?action=query&prop=info&format=json&revids=" + revid,
        dataType: "JSON",
        async: false,
        success: function (response) {
            var temp = response.query.pages;
            var keys = Object.keys(temp);
            var key = keys[0];
            temp = temp[key];
            latestrev = temp.lastrevid; //store the latest revision and compare outside the ajax function for scope reasons

            if (revid != latestrev) {
                console.log("Not latest revision");
                if (pendingNewPages.isEmpty()) {
                    //TODO: status update to "done"
                    console.info("New page queue is empty");
                } else {
                    setTimeout(AVT.processNewPageFilterDiff, AVTconfig.readDelay);
                    console.log("NP Queue length is: " + pendingNewPages.getLength());
                }
                return; //if they don't match, move on to the next item in the queue
            }

            console.log("Still latest, pulling full content");

            //since we're still working with the latest revision, let's get and process the diff
            $.ajax({
                url: "/w/api.php?action=query&prop=revisions&format=json&rvprop=timestamp%7Cuser%7Cparsedcomment%7Ccontent&revids=" + revid,
                dataType: "JSON",
                success: function (response) {
                    var temp = response.query.pages;
                    var keys = Object.keys(temp);
                    var key = keys[0];
                    temp = temp[key];
                    title = temp.title;
                    temp = temp.revisions; //navigate down the JSON tree

                    timestamp.setTime(Date.parse(temp.timestamp)); //parse the ISO timestamp returned by the server and store it in a date object
                    editor = temp.user;
                    summary = temp.parsedcomment;
                    content = temp["*"];

                    console.log("Testing for a match");

                    //now that we have our data, scan it
                    if (!badWords.test(content)) { //uses a fast method to test if there's a match at all; if there isn't, then go on to the next diff
                        console.log("No match");
                        if (pendingNewPages.isEmpty()) {
                            //TODO: status update to "done"
                            console.info("NP Queue is empty");
                        } else {
                            setTimeout(AVT.processNewPageFilterDiff, AVTconfig.readDelay);
                            console.log("NP Queue length is: " + pendingNewPages.getLength());
                        }
                        return;
                    }

                    console.log("Match found");

                    //since there's a match, we need to parse more thoroughly
                    matches = content.match(badWords); //get an array of the matches
                    content.replace(badWords, '<span style="background-color: yellow ! important">$&</span>'); //highlight each match in the content text for display

                    AVT.diffDisplay(title, editor, timestamp, summary, matches, content, revid, 1, false); //call the function to add this revision to the user's display

                    if (pendingNewPages.isEmpty()) {
                        //TODO: status update to "done"
                        console.info("New page queue is empty");
                        return;
                    } else {
                        setTimeout(AVT.processNewPageFilterDiff, AVTconfig.readDelay);
                        console.log("NP queue length is: " + pendingNewPages.getLength());
                    }
                }
            });
        }
    });
};

AVT.processFilterDiff = function() {
    if (AVT.paused) {
        console.info("AVT Paused");
        return; //abort if paused
    }

    if (AVT.rcStopSignal) {
        console.info("Script stopped.");
        return; //abort if stopped
    }

    if (pendingDiffs.isEmpty()) return; //abort if the queue is now empty

    var revid = pendingDiffs.dequeue(); //pop the top revision off the new page queue
    var title, content, diff, summary, timestamp, editor, matches, latestrev;
    timestamp = new Date();

    console.log("Revision is " + revid);

    $.ajax({ //retrieve information about the page -- specifically, we're looking to see if this is still the latest revision.  If it isn't, let's not waste resources downloading the diff.
        url: "/w/api.php?action=query&prop=info&format=json&revids=" + revid,
        dataType: "JSON",
        success: function (response) {
            var temp = response.query.pages;
            var keys = Object.keys(temp);
            var key = keys[0];
            temp = temp[key];
            latestrev = temp.lastrevid; //store the latest revision and compare outside the ajax function for scope reasons
            if (revid != latestrev) {
                console.log("Not latest revision");
                if (pendingDiffs.isEmpty()) {
                    //TODO: status update to "done"
                    console.info("Diff queue is empty");
                } else {
                    setTimeout(AVT.processFilterDiff, AVTconfig.readDelay);
                    console.log("Diff queue length is: " + pendingDiffs.getLength());
                }
                return; //if they don't match, move on to the next item in the queue
            }

            console.log("Still latest, pulling full content");

            //since we're still working with the latest revision, let's get and process the diff
            $.ajax({
                url: "/w/api.php?action=query&prop=revisions&format=json&rvprop=ids%7Ctimestamp%7Cuser%7Cparsedcomment&rvdiffto=prev&revids=" + revid,
                dataType: "JSON",
                success: function (response) {
                    var temp;
                    try {
                        temp = response.query.pages;
                        var keys = Object.keys(temp);
                        var key = keys[0];
                        temp = temp[key];
                        title = temp.title;
                        temp = temp.revisions[0]; //navigate down the JSON tree

                        //chop the Z off the timestamp, parse it into local time, then chop the timezone off the end and parse again to set GMT
                        timestamp.setTime(Date.parse(temp.timestamp.slice(0, -1)));
                        timestamp.setTime(Date.parse(timestamp.toString().slice(0, 28)));

                        editor = temp.user;
                        summary = temp.parsedcomment;
                        temp = temp.diff;
                        diff = temp["*"];
                    }
                    catch (e) {
                        console.error("Unexpected response from server. Response object follows:");
                        console.error(response);
                        console.log("Aborted due to error");
                        if (pendingDiffs.isEmpty()) {
                            //TODO: status update to "done"
                            console.info("Diff queue is empty");
                            return;
                        } else {
                            setTimeout(AVT.processFilterDiff, AVTconfig.readDelay);
                            console.log("Diff queue length is: " + pendingDiffs.getLength());
                            return;
                        }
                    }

                    if (AVT.whitelistCache.indexOf(editor) != -1) { //if the editor is in our whitelist cache, abort now
                        console.log("Editor whitelisted");
                        if (pendingDiffs.isEmpty()) {
                            //TODO: status update to "done"
                            console.info("Diff queue is empty");
                            return;
                        } else {
                            setTimeout(AVT.processFilterDiff, AVTconfig.readDelay);
                            console.log("Diff queue length is: " + pendingDiffs.getLength());
                            return;
                        }
                    } else {
                        console.log("Downloading editor properties");

                        $.ajax({
                            url: "/w/api.php?action=query&list=users&format=json&usprop=groups%7Ceditcount&ususers=" + editor,
                            dataType: "JSON",
                            success: function(response) {
                                var whitelisted = false;
                                var abort = false;
                                var userObj = response.query.users[0];

                                if (AVTfilters.editCountFilterOn && !userObj.hasOwnProperty("invalid")) { //do we care about edit count, and is this a registered user?
                                    if (userObj.editcount >= AVTfilters.editCountFilter) { //we do, so is their count over the filter threshold?
                                        whitelisted = true; //if it is, they're whitelisted
                                    }
                                }

                                if (AVTfilters.groupFilterOn && !userObj.hasOwnProperty("invalid")) { //do we care about user groups, and is this a registered user?
                                    for (var groupnum in AVTfilters.groupFilter) { //we do - so for each group listed in the options,
                                        if (AVTfilters.groupFilter.hasOwnProperty(groupnum)) { //make sure it's really listed in the options,
                                            if (userObj.groups.indexOf(AVTfilters.groupFilter[groupnum]) != -1) { //then see if the group is in the user's groups
                                                whitelisted = true; //if it is, they're whitelisted
                                            }
                                        }
                                    }
                                }

                                if (whitelisted) {
                                    AVT.whitelistCache.push(editor); //cache them
                                    console.log("Editor whitelisted");
                                    if (pendingDiffs.isEmpty()) {
                                        //TODO: status update to "done"
                                        console.info("Diff queue is empty");
                                    } else {
                                        setTimeout(AVT.processFilterDiff, AVTconfig.readDelay);
                                        console.log("Diff queue length is: " + pendingDiffs.getLength());
                                        return;
                                    }
                                }

                                console.log("Testing for a match");

                                //only the "green" cells from the diff should be matched - we need to parse out that text
                                var addedText = $(diff).find(".diff-addedline").text();

                                var knownVandal = false;

                                if (AVTvandals.hasOwnProperty(editor)) { //see if the editor's username is in the list of rolled-back vandals
                                    knownVandal = true;
                                } else {
                                    if (!badWords.test(addedText)) {
                                        abort = true; //not a known vandal, didn't match the diff -- abort
                                    }
                                }

                                if (abort) {
                                    console.log("No match");
                                    if (pendingDiffs.isEmpty()) {
                                        //TODO: status update to "done"
                                        console.info("Diff queue is empty");
                                    } else {
                                        setTimeout(AVT.processFilterDiff, AVTconfig.readDelay);
                                        console.log("Diff queue length is: " + pendingDiffs.getLength());
                                    }
                                    return;
                                }

                                console.log("Match found");

                                //since there's a match, we need to parse more thoroughly
                                if (!knownVandal) matches = addedText.match(badWords); //get an array of the matches

                                if (matches) matches = findUnique(matches); //filter out duplicates
                                //FIXME: matches is sometimes null here -- why? if there's no match, it should have been rejected up at the .test() call

                                diff = diff.replace(badWords, '<span style="background-color: yellow"><big>$&</big></span>'); //highlight each match in the content text for display

                                diff = "<table>" + diff + "</table>"; //the diff sent by the server starts with <tr>'s, no table tags are included

                                AVT.diffDisplay(title, editor, timestamp, summary, matches, diff, revid, 0, knownVandal); //call the function to add this revision to the user's display

                                if (pendingDiffs.isEmpty()) {
                                    //TODO: status update to "done"
                                    console.info("Diff Queue is empty");
                                    return;
                                } else {
                                    setTimeout(AVT.processFilterDiff, AVTconfig.readDelay);
                                    console.log("Diff queue length is: " + pendingDiffs.getLength());
                                }
                            }
                        });
                    }
                }
            });
        }
    });
};

AVT.diffDisplay = function(title, editor, timestamp, summary, matches, content, revid, isNewPage, isKnownVandal){ //function to generate and append the HTML to display a matching diff
    //this function uses single quotes for strings for ease of dealing with HTML attributes
    var newHTML, rollbackToken, rollbackLink, dismissLink, wlDismissLink, dismissPriorLink, temptime;
    var timearray = new Array();

    if (!matches && !isKnownVandal) return; //FIXME: why does matches come up null here from time to time? (and not on a known vandal)

    AVT.count++;

    newHTML = '<div id="AVTdiff' + AVT.count + '" class="diffDiv">' + '(' + AVT.count + ') '; //open the <div> with the next incremental count ID, and display the count

    newHTML += '[<a id="hidelink' + AVT.count + '" href="javascript:AVT.showHide(' + AVT.count + ')">'; //open hide/show link tag

    if (AVTconfig.showByDefault) { //add hide or show link and close tag
        newHTML += 'hide</a>] ';
    } else {
        newHTML += 'show</a>] ';
    }

    dismissLink = '[<a href="javascript:AVT.dismiss(' + AVT.count + ')">dismiss</a>] ';
    wlDismissLink = '[<a href="javascript:AVT.wlAndDismiss(\'' + editor + '\', ' + AVT.count + ')">whitelist + dismiss</a>] ';
    dismissPriorLink = '[<a href="javascript:AVT.dismissWithPrior(' + AVT.count + ')">dismiss + prior</a>] ';
    //we're saving them to add again at the bottom

    newHTML += dismissLink + dismissPriorLink; //add dismiss links

    //parse out the time components
    timearray[0] = timestamp.getUTCHours().toString();
    if (timearray[0].length == 1) timearray[0] = "0" + timearray[0]; //compensate for single digits
    timearray[1] = timestamp.getUTCMinutes().toString();
    if (timearray[1].length == 1) timearray[1] = "0" + timearray[1];
    timearray[2] = timestamp.getUTCSeconds().toString();
    if (timearray[2].length == 1) timearray[2] = "0" + timearray[2];

    temptime = timearray.join(":"); //now join the pieces together

    newHTML += temptime + ' UTC: '; //and add it

    if (isNewPage) {
        newHTML += 'New page '; //start the sentence with "new page"

        //next 3 lines perform escaping of the wikitext to prevent oddities if the editor used raw HTML tags or pseudo-tags like <nowiki> and  <ref>
        var escaped = content;
        var findReplace = [[/&/g, "&amp;"], [/</g, "&lt;"], [/>/g, "&gt;"], [/"/g, "&quot;"]];
        for(var item in findReplace) escaped = escaped.replace(findReplace[item][0], findReplace[item][1]);

        content = '<span style="font-family: monospace">' + escaped + '</span>'; //we want the wikitext monospaced, we have to do this after escaping to preserve the span tag
    } else {
        newHTML += 'Edit to page '; //no escaping is necessary for diffs, as the server should handle that already
    }

    newHTML += AVT.wikiLink(title) + " "; //add the title

    if (!isNewPage) { //if this is NOT a new page, add history, talk, and logs links
        newHTML += '(' + AVT.specialLink(title, "history") + ' | ' + AVT.specialLink(title, "talk") + ' | ' + AVT.specialLink(title, "logs") + ') ';
    }

    if (!isKnownVandal) {
        newHTML += 'matched <b>' + matches.join(', ') + "</b> "; //add matches separated by a comma and space
    } else {
        var kvCount = AVTvandals[editor];
        newHTML += (isNewPage ? 'created' : 'performed') + ' by <span style="font-color: red"><b>an editor you rolled back ' + kvCount + ' time' + (kvcount > 1 ? 's.' : '.') + ' </b></span> ';
    }

    //assemble line of links to rollback function, save it for later to add to the bottom
    //signature for rollback function is (editor, revid, divNumber, warnType)
    var rollbackfrag = "[<a href=\"javascript:AVT.rollback('" + editor + "', " + revid + ", " + AVT.count + ", "; //string is not closed to allow multiple warntypes

    var rollbackLine = "<br>" + rollbackfrag + "'none')\">rollback only</a>] Revert and warn: " + rollbackfrag + "'vandalism')\">vandalism</a>] " + rollbackfrag + "'test')\">test edit</a>] ";
    rollbackLine += rollbackfrag + "'delete')\">blanking</a>] " + rollbackfrag + "'joke')\">joke</a>] " + rollbackfrag + "'biog')\">BLP</a>] " + rollbackfrag + "'defam')\">defamation</a>] ";

    //add it to the HTML
    newHTML += rollbackLine + '<br>'; //and go to second line

    if (isNewPage) {
        newHTML += 'Created by ';
    } else {
        newHTML += 'Edited by ';
    }

    //editor name and user research links on separate line
    newHTML += AVT.userLink(editor, "userpage") + ' (' + AVT.userLink(editor, "user talk", title) + ' | ' + AVT.userLink(editor, "contribs") + ' | ' + AVT.userLink(editor, "block log") + ' | ' + AVT.userLink(editor, "block") + ' | ' + AVT.userLink(editor, "whitelist") + ')<br>';

    //edit summary
    if (!summary) summary = "<small>No edit summary provided</small>";
    newHTML += 'Summary: (<i>' + summary + '</i>)<br>'; //TODO: links in the summary open in current tab - need to add "target='_blank'" to each <a> tag in the summary

    //now the content to display. this is wrapped in its own id'd DIV to allow collapse/expand functionality
    newHTML += '<div id="AVTextended' + AVT.count + '">' + content + dismissLink + wlDismissLink + dismissPriorLink + rollbackLine + '</div>';

    //now an HR to end the listing and close the outer DIV
    newHTML += '<br><hr></div>';

    //add the new HTML to the page
    $("#DAVTcontent").append(newHTML);

    if (!AVTconfig.showByDefault) { //hide the diff if the setting calls for that
        $("#AVTextended" + AVT.count).css("display", "none");
    }

	if (typeof(window.setupTooltips)!='undefined') { //the Navigation Popups script doesn't know about the new div by default
        setupTooltips(document.getElementById('AVTdiff' + AVT.count));
    }
};

AVT.loadBadWords=function(){ //request the bad words wiki page from the API -- keeping the regexen on wiki allows for easy updating
    $.ajax({
        url: "/w/api.php?action=query&prop=revisions&format=json&rvprop=content&rvlimit=1&rvcontentformat=text%2Fx-wiki&titles=User%3ADarkwind%2FDAVT%2Fbadwords",
        dataType: "JSON",
        async: false,
        success: function (response) {
            var raw1 = response.query.pages["40929001"]; //traverse the API's excessively complicated JSON response
            var raw2 = raw1.revisions[0]; //which uses non-standard identifiers
            var raw3 = raw2["*"]; //making stuff like this necessary

            var data = raw3.split("\n"); //now split the page data into an array, each line in its own element

            var phrase=[]; //declare variables used when parsing the badword list
            var string=[];

            for (var i=0; i<data.length; ++i) {
                var s=data[i];

                // ignore empty lines, whitespace-only lines and lines starting with '<'
                if (/^\s*$|^</.test(s)) { continue; }

                // lines beginning and ending with a (back-)slash (and possibly trailing
                // whitespace) are treated as regexps
                if (/^([\\\/]).*\1\s*$/.test(s)) {
                    var isPhrase=(s.charAt(0)=='/');
                    // remove slashes and trailing whitespace
                    s=s.replace(/^([\\\/])|([\\\/]\s*$)/g, '');
                    // escape opening parens: ( -> (?:
                    s=s.replace(/\(?!\?/g, '(?:');
                    // check that s represents a valid regexp
                    try { var r=new RegExp(s); }
                    catch (err) {
                        var errDiv=newOutputDiv('recent2_error', recent2.outputPosition);
                        errDiv.innerHTML='Warning: ignoring odd-looking regexp on line '+i+
                            ' of <a href="' + mw.util.wikiGetlink(recent2.badwordsUrl) +
                            '">badwords</a>:<pre>' + s + '</pre>';
                        continue;
                    }
                    if (isPhrase) {
                        phrase.push(s);
                    } else {
                        string.push(s);
                    }
                } else {
                    // treat this line as a non-regexp and escape it.
                    phrase.push(s.replace(RegExp('([-|.()\\+:!,?*^${}\\[\\]])', 'g'), '\\$1'));
                }
            }
            //                      123                                3       2|4                        4|5         56                        67        71
            //                      (((    repeated char               )       )|(   ... | strings | ...  )|( border  )(   ... | phrases | ...  )( border ))
            badWords = RegExp("((([^\\-\\|\\{\\}\\].\\s'=wI:*#0-9a-f])\\3{2,})|(" + string.join('|') + ")|(^|[^/\\w])(" + phrase.join('|') + ")(?![/\\w]))", 'gi');
        }
    });
    return 1;
};

AVT.rcTimeout=function(){ //a function callable via setTimeout (or otherwise) to end the RC download/parse process
    AVT.rcStopSignal = 1; //stop the script right away, as the function may otherwise continue in the background due to the setInterval
    console.warn("DAVT script stopped pending user response to presence check.");
    if (confirm("Press OK to continue using the anti-vandal tool.")) { //if the user wants to continue, restart the download process
        AVT.rcStopSignal = 0;
        setTimeout(AVT.rcTimeout, AVT.timeDelay); //reset the timeout
        AVT.rcDownloadFilter();
    }
};

AVT.wikiLink = function(pageTitle) { //takes an article title (with spaces and namespace), converts it to a full URL, and returns it wrapped with an <a> tag.
    var URL, HTML, originalTitle;
    originalTitle = pageTitle;
    pageTitle = pageTitle.replace(" ", "_", "g"); //replace spaces with underscores
    encodeURIComponent(pageTitle); //now encode it
    URL = "https://en.wikipedia.org/wiki/" + pageTitle;
    HTML = '<a href="' + URL + '" target="_blank">' + originalTitle + '</a>';
    return HTML;
};

AVT.specialLink = function(pageTitle, pageType, display) { //takes an article title and returns a link to the specified special page, including <a> tag and word(s) to display
    var URL, HTML;
    pageTitle = pageTitle.replace(" ", "_", "g"); //replace spaces with underscores
    encodeURIComponent(pageTitle); //now encode it

    switch (pageType) {
        case "history":
            URL = "https://en.wikipedia.org/w/index.php?title=" + pageTitle + "&action=history";
            break;
        case "talk":
            URL = "https://en.wikipedia.org/wiki/Talk:" + pageTitle;
            break;
        case "logs":
            URL = "https://en.wikipedia.org/w/index.php?title=Special:Log&page=" + pageTitle;
            break;
    }

    if (display) { //if there's a string for the display title, use it, otherwise use the pageType
        HTML = '<a href="' + URL + '" target="_blank">' + display + '</a>';
    } else {
        HTML = '<a href="' + URL + '" target="_blank">' + pageType + '</a>';
    }

    return HTML;
};

AVT.userLink = function(userName, pageType, artTitle, display) { //editor, what kind of editor function we want, [article title, [link text]]
    var URL, HTML, originalName;
    originalName = userName;
    userName = userName.replace(" ", "_", "g"); //replace spaces with underscores
    //we do not similarly escape the pageTitle in this function because TW takes the underscores literally
    encodeURIComponent(userName); //now encode it

    switch (pageType) {
        case "userpage":
            URL = "https://en.wikipedia.org/wiki/User:" + userName;
            if (!display) display = originalName;
            break;
        case "user talk": //includes a parameter for TW users to populate the article title when warning or welcoming
            URL = "https://en.wikipedia.org/wiki/User_talk:" + userName;
            if (artTitle) URL += "?vanarticle=" + artTitle;
            if (!display) display = "talk";
            break;
        case "contribs":
            URL = "https://en.wikipedia.org/wiki/Special:Contributions/" + userName;
            if (!display) display = "contribs";
            break;
        case "block log":
            URL = "https://en.wikipedia.org/w/index.php?title=Special:Log/block&page=User:" + userName;
            if (!display) display = "block log";
            break;
        case "block":
            URL = "https://en.wikipedia.org/wiki/Special:Block/" + userName;
            if (!display) display = "block";
            break;
        case "whitelist":
            URL = "javascript:AVT.addWhitelist('" + originalName + "')";
            if (!display) display = "whitelist";
            break;
    }

    if (pageType != "whitelist") HTML = '<a href="' + URL + '" target="_blank">' + display + '</a>';
        else HTML = '<a href="' + URL + '">' + display + '</a>'; //no target if JS link

    return HTML;
};

AVT.showHide = function(div) {
    var linkText = $("#hidelink" + div).text();
    //console.log("linkText for div " + div + " is " + linkText);
    switch (linkText) {
        case "hide":
            $("#AVTextended" + div).css("display", "none");
            $("#hidelink" + div).text("show");
            break;
        case "show":
            $("#AVTextended" + div).css("display", "inline");
            $("#hidelink" + div).text("hide");
            break;
    }
};

AVT.dismiss = function(div) {
    $("#AVTdiff" + div).remove(); //remove the requested div
    console.log("Div #%d dismissed", div);
    $("#AVTdiff" + (div + 1)).scrollintoview(); //scroll the subsequent div to the top of the page - will only work if you haven't been removing divs out of sequence
};

AVT.rollback = function(editor, revid, divNumber, warnType) { //this function uses the API to roll back, which still requires the rollback right
    //warnType is a string, valid values are "none", "vandalism", "test", "delete" (blanking), "joke", "biog" (BLP vios), "defam" (defamatory content)
    var warningPriority = false; //boolean to use to indicate the type of warning takes precedence over welcoming

    $("#AVTextended" + divNumber).children("table").remove(); //keep the extended div but clear the table with the vandal's diff
    $("#AVTextended" + divNumber).prepend('<div id="Rollback' + divNumber + '"><center id="Center' + divNumber + '">Attempting rollback:<br>Fetching token...</center></div>');

    var rollbackSummary = "Reverted edit(s) by [[Special:Contributions/" + editor + "|" + editor + "]] identified as ";

    switch (warnType) {
        case "none":
        case "vandalism":
            rollbackSummary += "vandalism ";
            break;
        case "test":
            rollbackSummary += "test edit(s) ";
            break;
        case "delete":
            rollbackSummary += "unexplained content removal ";
            break;
        case "joke":
            rollbackSummary += "vandalism (joke edit(s)) ";
            break;
        case "biog":
            rollbackSummary += "[[WP:BLP|BLP]] violation ";
            warningPriority = true;
            break;
        case "defam":
            rollbackSummary += "[[WP:LIBEL|libelous or defamatory content]] ";
            warningPriority = true;
            break;
        default:
            alert("Unexpected value of warnType");
            return;
    }

    rollbackSummary += "([[User:Darkwind/DAVT|DAVT]])"; //mini-ad for the tool

    $.ajax({ //obtain a rollback token, the page title, and the editor's status (registered or anon)
        url: "/w/api.php",
        dataType: "JSON",
        data: {
            action: "query",
            prop: "revisions",
            format: "json",
            rvtoken: "rollback",
            revids: revid
        },
        success: function (response) {
            var isAnon;
            var key = Object.keys(response.query.pages)[0];
            var rollbackToken = response.query.pages[key].revisions[0].rollbacktoken;
            var title = response.query.pages[key].title;
            if (response.query.pages[key].revisions[0].hasOwnProperty("anon")) {
                isAnon = true;
            } else {
                isAnon = false;
            }

            $("#Center" + divNumber).append("Done<br>Performing rollback...");

            $.ajax({ //do the rollback
                url: "/w/api.php",
                dataType: "JSON",
                type: "POST",
                data: { action: "rollback", format: "json", user: editor, title: title, token: rollbackToken, summary: rollbackSummary },
                success: function (response) { //process the response from our attempted rollback
                    if (response.hasOwnProperty("error")) {
                        //display the error, which is in the string response.error.info
                        $("#Center" + divNumber).append("<span style='color:red'>Rollback failed with error: " + response.error.info + "</span>");
                    } else {
                        var temp2 = response.rollback;
                        if (temp2.revid === 0) {
                            $("#Center" + divNumber).append("<span style='color:red'>Failed: no changes were made - likely self-revert</span>");
                        } else {
                            $("#Center" + divNumber).append("Done");
                            var newHTML = "<p><center><b>Rollback results:</b></center><p><table>"; //label and open the table tag

                            $.ajax({ //get the new diff
                                url: "/w/api.php",
                                dataType: "JSON",
                                data: { action: "query", prop: "revisions", format: "json", revids: temp2.revid, rvdiffto: "prev" },
                                success: function (response) {
                                    var temp3 = response.query.pages;
                                    var keys = Object.keys(temp3);
                                    var key = keys[0];
                                    temp3 = temp3[key];
                                    temp3 = temp3.revisions[0]; //navigate down the JSON tree
                                    temp3 = temp3.diff;
                                    var diff = temp3["*"];

                                    newHTML += diff + "</table>"; //close the table tag
                                    $("#Rollback" + divNumber).append(newHTML); //add the HTML
                                }
                            });

                            //If option is set, pop a window with the vandal's talk page because the rollback was successful - but only for non-warn rollbacks
                            if (AVTconfig.popTalkAfterRollback && warnType == "none") {
                                var vandalTalk = "https://en.wikipedia.org/wiki/User_talk:" + editor + "?vanarticle=" + title;
                                window.open(vandalTalk, "_blank");
                            }

                            if (warnType != "none") { //automatically issue a warning if requested
                                var talkExists, talkWikiText, newHeader, warnLevel;
                                var date = new Date();
                                var warningRegEx = /<!-- Template:uw-.*([1-4]) -->.*?(\d{1,2}:\d{1,2}, \d{1,2} \w+ \d{4}) \(UTC\)/g;
                                var headerRegEx = new RegExp( "^==+\\s*(?:" + date.getUTCMonthName() + '|' + date.getUTCMonthNameAbbrev() + ")\\s+" + date.getUTCFullYear() + "\\s*==$(?![\\s\\S]*^==.+==$)", 'm' ); //will only match if current month's section header is the last section

                                $("#Center" + divNumber).append("<br>Warning vandal...");

                                $.ajax({ //attempt to download the talk page wikitext
                                    url: "/w/api.php",
                                    dataType: "JSON",
                                    data: { action: "query", prop: "revisions", format: "json", rvprop: "content", titles: "User_talk:" + editor },
                                    success: function (response) {
                                        var temp4 = response.query.pages;
                                        keys = Object.keys(temp4);
                                        key = keys[0];
                                        var latest = new Date(0);

                                        if (key < 0) { //if the key (page ID) is negative, the page does not exist
                                            talkExists = false;
                                            newHeader = true;
                                            warnLevel = 0;
                                        } else {
                                            var event;

                                            talkExists = true;
                                            temp4 = temp4[key];
                                            temp4 = temp4.revisions[0]; //navigate down the JSON tree
                                            talkWikiText = temp4["*"]; // * is the identifier for the wikitext

                                            if (warningRegEx.test(talkWikiText)) {
                                                while ((event = warningRegEx.exec(talkWikiText))) {
                                                    event.date = Date.parse(event[2] + " UTC");
                                                    if (event.date > latest.getTime()) {
                                                        latest.setTime(event.date); //if the current event is later than the latest so far, update latest
                                                        warnLevel = parseInt(event[1], 10); //10 = base 10 (radix)
                                                    }
                                                }
                                                if ((date.getTime() - latest.getTime()) > (AVTconfig.warningAge * 86400000)) { //86,400,000 ms per day
                                                    warnLevel = 0;
                                                }
                                            } else {
                                                warnLevel = 0;
                                            }

                                            if (headerRegEx.test(talkWikiText)) {
                                                newHeader = false;
                                            } else {
                                                newHeader = true;
                                            }
                                        }

                                        warnLevel++; //the warnLevel was the level detected, now we need to bump it up one to issue the right warning
                                        var newMessage = "\n";
                                        var editSummary = "";
                                        var abort = false;
                                        var welcoming = false;
                                        var templateName = "";

                                        if (talkExists || warningPriority) { //if the talk page exists or we're issuing a priority warning, we don't need to worry about welcome settings
                                            templateName = "uw-" + warnType;
                                            if (newHeader) {
                                                newMessage += "== " + date.getUTCMonthName() + " " + date.getUTCFullYear() + " ==\n"; //create a header if needed
                                            } else {
                                                newMessage += "\n"; //start with two newlines in case of pre-existing talk and no header (to create proper spacing)
                                            }
                                        } else { //the talk page doesn't exist, so we need to check anon status and appropriate config setting to see if we're welcoming or warning
                                            if (isAnon) {
                                                if (AVTconfig.welcomeAnon) { //user is anon (isAnon = true) - do we welcome anon users?
                                                    templateName = "welcome-anon-unconstructive"; //yes (true)
                                                    welcoming = true;
                                                } else {
                                                    templateName = "uw-" + warnType; //no (false)
                                                }
                                            } else {
                                                if (AVTconfig.welcomeReg) { //user is registered (isAnon = false) - do we welcome registered users?
                                                    templateName = "welcomevandal"; //yes (true)
                                                    welcoming = true;
                                                } else {
                                                    templateName = "uw-" + warnType; //no (false)
                                                }
                                            }
                                        }

                                        if (!welcoming) {
                                            newMessage += "{{subst:" + templateName + warnLevel + "|" + title + "}} ~~~~";

                                            switch (warnLevel) { //set appropriate edit summary
                                                case 1:
                                                    editSummary += "Message regarding edits to [[" + title + "]] ([[User:Darkwind/DAVT|DAVT]])";
                                                    break;
                                                case 2:
                                                    editSummary += "Unhelpful edits to [[" + title + "]] ([[User:Darkwind/DAVT|DAVT]])";
                                                    break;
                                                case 3:
                                                    editSummary += "Caution: disruptive edits to [[" + title + "]] ([[User:Darkwind/DAVT|DAVT]])";
                                                    break;
                                                case 4:
                                                    editSummary += "Final warning regarding edits to [[" + title + "]] ([[User:Darkwind/DAVT|DAVT]])";
                                                    break;
                                                case 5:
                                                    $("#Center" + divNumber).append("<span style='color:red'>User already has a level 4 warning in the past " + AVTconfig.warningAge + " days. Warning aborted - consider ARV or block.</span>");
                                                    abort = true;
                                                    break;
                                                default:
                                                    $("#Center" + divNumber).append("<span style='color:red'>Error: unexpected warnLevel value: " + warnLevel + "; Warning aborted.</span>");
                                                    abort = true;
                                                    break;
                                            }
                                        } else {
                                            newMessage += "{{subst:" + templateName + "|" + title + "}}"; //neither warning level nor signature apply to welcoming templates
                                            editSummary += "Welcome to Wikipedia ([[User:Darkwind/DAVT|DAVT]])";
                                        }

                                        if (!abort) {
                                            $.ajax({
                                                url: "/w/api.php",
                                                dataType: "JSON",
                                                type: "POST",
                                                data: { action: "edit", title: "User talk:" + editor, summary: editSummary, appendtext: newMessage, format: "json", token: AVT.editToken },
                                                success: function (response) {
                                                    if (response.edit.result == "Success") {
                                                        if (!welcoming) {
                                                            $("#Center" + divNumber).append("Done with template " + templateName + warnLevel);
                                                        } else {
                                                            $("#Center" + divNumber).append("Welcomed user");
                                                        }
                                                    } else {
                                                        $("#Center" + divNumber).append("Error: " + response.edit.result);
                                                    }
                                                }
                                            });
                                        }
                                    }
                                });
                            }
                        }
                    }
                },
                error: function( xhr ) {
                    alert( 'Error: Request failed.' );
                }
            });
        }
    });

    if (AVTvandals.hasOwnProperty(editor)) AVTvandals[editor] += 1; //if we've already recorded them, increment their rollback counter
        else AVTvandals[editor] = 1; //otherwise, create their entry, set to 1
};

AVT.pauseResume = function() {
    if (!AVT.paused) {
        AVT.paused = 1;
        clearTimeout(AVT.AYTtimer); //stop the user-presence check timer
        $("#AVTpause").text("Resume updates");
    } else {
            AVT.paused = 0;
            console.info("AVT resuming");
            $("#AVTpause").text("Pause updates");
            AVT.AYTtimer = setTimeout(AVT.rcTimeout, AVT.timeDelay); //restart the user-presence check timer
            AVT.rcDownloadFilter(); //re-trigger the AVT processing
        }
};

AVT.addWhitelist = function(editor) {
    AVT.whitelistCache.push(editor);
    console.log("Editor %s added to whitelist", editor);
};

AVT.wlAndDismiss = function(editor, div) {
    AVT.addWhitelist(editor);
    AVT.dismiss(div);
};

AVT.dismissWithPrior = function(div) {
    for (var q = div-1; q > 0; q--) { //start with the divs above, then dismiss the one we clicked on
        $("#AVTdiff" + q).remove();
    }
    AVT.dismiss(div); //call dismiss function on the div we clicked on - that function includes scrolling to the next div
};

$(document).ready(AVT.onLoad); //trigger the initial script processing when the page is done loading

function findUnique(arr) {
    return $.grep(arr,function(v,k){
        return $.inArray(v,arr) === k;
    });
}

function Queue(){ //queue library (found online licensed as CC-zero)
var _1=[];
var _2=0;
this.getLength=function(){
return (_1.length-_2);
};
this.isEmpty=function(){
return (_1.length==0);
};
this.enqueue=function(_3){
_1.push(_3);
};
this.dequeue=function(){
if(_1.length==0){
return undefined;
}
var _4=_1[_2];
if(++_2*2>=_1.length){
_1=_1.slice(_2);
_2=0;
}
return _4;
};
this.peek=function(){
return (_1.length>0?_1[_2]:undefined);
};
};

/*
* jQuery scrollintoview() plugin and :scrollable selector filter
*
* Version 1.8 (14 Jul 2011)
* Requires jQuery 1.4 or newer
*
* Copyright (c) 2011 Robert Koritnik
* Licensed under the terms of the MIT license
* http://www.opensource.org/licenses/mit-license.php
*/
(function(f){var c={vertical:{x:false,y:true},horizontal:{x:true,y:false},both:{x:true,y:true},x:{x:true,y:false},y:{x:false,y:true}};var b={duration:"fast",direction:"both"};var e=/^(?:html)$/i;var g=function(k,j){j=j||(document.defaultView&&document.defaultView.getComputedStyle?document.defaultView.getComputedStyle(k,null):k.currentStyle);var i=document.defaultView&&document.defaultView.getComputedStyle?true:false;var h={top:(parseFloat(i?j.borderTopWidth:f.css(k,"borderTopWidth"))||0),left:(parseFloat(i?j.borderLeftWidth:f.css(k,"borderLeftWidth"))||0),bottom:(parseFloat(i?j.borderBottomWidth:f.css(k,"borderBottomWidth"))||0),right:(parseFloat(i?j.borderRightWidth:f.css(k,"borderRightWidth"))||0)};return{top:h.top,left:h.left,bottom:h.bottom,right:h.right,vertical:h.top+h.bottom,horizontal:h.left+h.right}};var d=function(h){var j=f(window);var i=e.test(h[0].nodeName);return{border:i?{top:0,left:0,bottom:0,right:0}:g(h[0]),scroll:{top:(i?j:h).scrollTop(),left:(i?j:h).scrollLeft()},scrollbar:{right:i?0:h.innerWidth()-h[0].clientWidth,bottom:i?0:h.innerHeight()-h[0].clientHeight},rect:(function(){var k=h[0].getBoundingClientRect();return{top:i?0:k.top,left:i?0:k.left,bottom:i?h[0].clientHeight:k.bottom,right:i?h[0].clientWidth:k.right}})()}};f.fn.extend({scrollintoview:function(j){j=f.extend({},b,j);j.direction=c[typeof(j.direction)==="string"&&j.direction.toLowerCase()]||c.both;var n="";if(j.direction.x===true){n="horizontal"}if(j.direction.y===true){n=n?"both":"vertical"}var l=this.eq(0);var i=l.closest(":scrollable("+n+")");if(i.length>0){i=i.eq(0);var m={e:d(l),s:d(i)};var h={top:m.e.rect.top-(m.s.rect.top+m.s.border.top),bottom:m.s.rect.bottom-m.s.border.bottom-m.s.scrollbar.bottom-m.e.rect.bottom,left:m.e.rect.left-(m.s.rect.left+m.s.border.left),right:m.s.rect.right-m.s.border.right-m.s.scrollbar.right-m.e.rect.right};var k={};if(j.direction.y===true){if(h.top<0){k.scrollTop=m.s.scroll.top+h.top}else{if(h.top>0&&h.bottom<0){k.scrollTop=m.s.scroll.top+Math.min(h.top,-h.bottom)}}}if(j.direction.x===true){if(h.left<0){k.scrollLeft=m.s.scroll.left+h.left}else{if(h.left>0&&h.right<0){k.scrollLeft=m.s.scroll.left+Math.min(h.left,-h.right)}}}if(!f.isEmptyObject(k)){if(e.test(i[0].nodeName)){i=f("html,body")}i.animate(k,j.duration).eq(0).queue(function(o){f.isFunction(j.complete)&&j.complete.call(i[0]);o()})}else{f.isFunction(j.complete)&&j.complete.call(i[0])}}return this}});var a={auto:true,scroll:true,visible:false,hidden:false};f.extend(f.expr[":"],{scrollable:function(k,i,n,h){var m=c[typeof(n[3])==="string"&&n[3].toLowerCase()]||c.both;var l=(document.defaultView&&document.defaultView.getComputedStyle?document.defaultView.getComputedStyle(k,null):k.currentStyle);var o={x:a[l.overflowX.toLowerCase()]||false,y:a[l.overflowY.toLowerCase()]||false,isRoot:e.test(k.nodeName)};if(!o.x&&!o.y&&!o.isRoot){return false}var j={height:{scroll:k.scrollHeight,client:k.clientHeight},width:{scroll:k.scrollWidth,client:k.clientWidth},scrollableX:function(){return(o.x||o.isRoot)&&this.width.scroll>this.width.client},scrollableY:function(){return(o.y||o.isRoot)&&this.height.scroll>this.height.client}};return m.y&&j.scrollableY()||m.x&&j.scrollableX()}})})(jQuery);
